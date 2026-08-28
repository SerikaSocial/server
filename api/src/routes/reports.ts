import { Elysia, t } from "elysia";
import { authed, adminOnly } from "../auth-plugin.ts";
import { prisma } from "../db.ts";
import { audit } from "../audit.ts";

/// Abuse reports against users and worlds. Filed from the game client (player list, pause
/// menu) and the web (profiles, world pages); worked from the admin report queue.
///
/// The category list is a shared contract — the game client and web hardcode the same
/// order. Append only, never reorder or renumber.

export const REPORT_CATEGORIES = [
  "harassment",
  "hate_speech",
  "sexual_content",
  "violence_gore",
  "spam_scam",
  "impersonation",
  "cheating",
  "inappropriate_content",
  "other",
] as const;

export const reportCategoryLabel = (n: number): string =>
  REPORT_CATEGORIES[n] ?? "other";

const REPORT_STATUS = ["open", "actioned", "dismissed"] as const;
const reportStatusLabel = (n: number): string => REPORT_STATUS[n] ?? "open";

/// How many reports one user may file per rolling 24 h. Generous for a real user, small
/// enough that a malicious client cannot flood the queue unattended.
const DAILY_REPORT_LIMIT = 30;
const MAX_DETAILS = 2000;

function serialize(r: {
  id: string;
  targetType: number;
  targetUserId: string | null;
  targetWorldId: string | null;
  category: number;
  details: string;
  status: number;
  createdAt: Date;
  targetUser?: { id: string; username: string; displayName: string | null } | null;
  targetWorld?: { id: string; name: string } | null;
}) {
  return {
    id: r.id,
    targetType: r.targetType === 1 ? "world" : "user",
    targetUserId: r.targetUserId,
    targetWorldId: r.targetWorldId,
    targetLabel: r.targetUser
      ? r.targetUser.displayName ?? r.targetUser.username
      : r.targetWorld?.name ?? null,
    category: r.category,
    categoryLabel: reportCategoryLabel(r.category),
    details: r.details,
    status: r.status,
    statusLabel: reportStatusLabel(r.status),
    createdAt: r.createdAt,
  };
}

export const reportRoutes = new Elysia({ prefix: "/v1/reports" })
  .use(authed)

  // File a report against a user or a world.
  .post(
    "/",
    async ({ session, body, set }) => {
      const targetType = body.targetType === "world" ? 1 : 0;
      const details = (body.details ?? "").trim().slice(0, MAX_DETAILS);
      if (body.category < 0 || body.category >= REPORT_CATEGORIES.length) {
        set.status = 400;
        return { error: "invalid_category" };
      }

      let targetUserId: string | null = null;
      let targetWorldId: string | null = null;
      if (targetType === 0) {
        if (body.targetId === session.sub) {
          set.status = 400;
          return { error: "cannot_report_self" };
        }
        const target = await prisma.user.findUnique({
          where: { id: body.targetId },
          select: { id: true },
        });
        if (!target) {
          set.status = 404;
          return { error: "user_not_found" };
        }
        targetUserId = target.id;
      } else {
        const target = await prisma.world.findUnique({
          where: { id: body.targetId },
          select: { id: true },
        });
        if (!target) {
          set.status = 404;
          return { error: "world_not_found" };
        }
        targetWorldId = target.id;
      }

      // One open report per reporter+target — a second report of the same target while the
      // first is still open is noise, not new information.
      const dupe = await prisma.report.findFirst({
        where: { reporterId: session.sub, targetType, targetUserId, targetWorldId, status: 0 },
        select: { id: true },
      });
      if (dupe) {
        set.status = 409;
        return { error: "already_reported" };
      }

      // Rolling per-reporter cap so a hostile client cannot fill the admin queue.
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const filed = await prisma.report.count({
        where: { reporterId: session.sub, createdAt: { gte: since } },
      });
      if (filed >= DAILY_REPORT_LIMIT) {
        set.status = 429;
        return { error: "report_rate_limited" };
      }

      const report = await prisma.report.create({
        data: {
          reporterId: session.sub,
          targetType,
          targetUserId,
          targetWorldId,
          category: body.category,
          details,
          instanceId: body.instanceId ?? null,
        },
      });
      return { status: "filed", id: report.id };
    },
    {
      body: t.Object({
        targetType: t.String(),
        targetId: t.String(),
        category: t.Integer(),
        details: t.Optional(t.String()),
        instanceId: t.Optional(t.String()),
      }),
    },
  )

  // The caller's own reports and their outcomes ("what happened to my report?").
  .get("/mine", async ({ session }) => {
    const reports = await prisma.report.findMany({
      where: { reporterId: session.sub },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        targetUser: { select: { id: true, username: true, displayName: true } },
        targetWorld: { select: { id: true, name: true } },
      },
    });
    return { reports: reports.map(serialize) };
  });

export const adminReportRoutes = new Elysia({ prefix: "/v1/admin/reports" })
  .use(adminOnly)

  // The moderation queue. `status=open` by default; each item carries the target's context
  // and how many OTHER open reports point at the same target, so pile-ons are visible
  // without cross-referencing.
  .get(
    "/queue",
    async ({ query }) => {
      const status =
        query.status === "actioned" ? 1 : query.status === "dismissed" ? 2 : query.status === "all" ? undefined : 0;

      const [reports, counts] = await Promise.all([
        prisma.report.findMany({
          where: status === undefined ? {} : { status },
          orderBy: { createdAt: "desc" },
          take: 100,
          include: {
            reporter: { select: { id: true, username: true, displayName: true } },
            targetUser: {
              select: { id: true, username: true, displayName: true, trustLevel: true, isAdmin: true, createdAt: true },
            },
            targetWorld: {
              select: { id: true, name: true, releaseStatus: true, author: { select: { username: true } } },
            },
          },
        }),
        prisma.report.groupBy({ by: ["status"], _count: { _all: true } }),
      ]);

      // How many other open reports exist against each target — one query, then join in memory.
      const openByTarget = new Map<string, number>();
      const userTargets = reports.filter((r) => r.targetUserId).map((r) => r.targetUserId!);
      const worldTargets = reports.filter((r) => r.targetWorldId).map((r) => r.targetWorldId!);
      if (userTargets.length > 0) {
        const grouped = await prisma.report.groupBy({
          by: ["targetUserId"],
          where: { targetType: 0, targetUserId: { in: userTargets }, status: 0 },
          _count: { _all: true },
        });
        for (const g of grouped) openByTarget.set(`u:${g.targetUserId}`, g._count._all);
      }
      if (worldTargets.length > 0) {
        const grouped = await prisma.report.groupBy({
          by: ["targetWorldId"],
          where: { targetType: 1, targetWorldId: { in: worldTargets }, status: 0 },
          _count: { _all: true },
        });
        for (const g of grouped) openByTarget.set(`w:${g.targetWorldId}`, g._count._all);
      }

      const queue = reports.map((r) => {
        const key = r.targetUserId ? `u:${r.targetUserId}` : `w:${r.targetWorldId}`;
        return {
          ...serialize(r),
          ageMs: Date.now() - r.createdAt.getTime(),
          reporter: r.reporter,
          targetUser: r.targetUser,
          targetWorld: r.targetWorld
            ? {
                id: r.targetWorld.id,
                name: r.targetWorld.name,
                releaseStatus: r.targetWorld.releaseStatus,
                authorUsername: r.targetWorld.author?.username ?? null,
              }
            : null,
          otherOpenReports: Math.max(0, (openByTarget.get(key) ?? 1) - 1),
        };
      });

      return {
        counts: {
          open: counts.find((c) => c.status === 0)?._count._all ?? 0,
          actioned: counts.find((c) => c.status === 1)?._count._all ?? 0,
          dismissed: counts.find((c) => c.status === 2)?._count._all ?? 0,
        },
        queue,
      };
    },
    { query: t.Object({ status: t.Optional(t.String()) }) },
  )

  // Resolve a report. Optionally records a moderation action against the reported user
  // (warn / platform-ban record — the enforced account ban itself lives in serika-accounts)
  // and/or takes the reported world down from browse.
  .post(
    "/:id/resolve",
    async ({ admin, params, body, set }) => {
      const report = await prisma.report.findUnique({ where: { id: params.id } });
      if (!report) {
        set.status = 404;
        return { error: "report_not_found" };
      }
      if (report.status !== 0) {
        set.status = 409;
        return { error: "already_resolved" };
      }
      const decision = body.decision === "actioned" ? 1 : 2;
      const notes = (body.notes ?? "").trim().slice(0, MAX_DETAILS);
      const reason = `report:${report.id} ${reportCategoryLabel(report.category)}${notes ? ` — ${notes}` : ""}`;

      if (decision === 1 && report.targetType === 0 && report.targetUserId) {
        // kind 0=warn 3=platform-ban — see ModerationAction in schema.prisma.
        const kind = body.platformBan ? 3 : body.warn ? 0 : null;
        if (kind !== null) {
          await prisma.moderationAction.create({
            data: { actorId: admin.sub, targetId: report.targetUserId, kind, reason },
          });
          await audit("moderation.report_action", {
            actorId: admin.sub,
            subjectId: report.targetUserId,
            detail: { reportId: report.id, kind, reason },
          });
        }
      }

      if (decision === 1 && report.targetType === 1 && report.targetWorldId && body.unpublishWorld) {
        // Take the world out of browse (private). The author keeps the row and can appeal;
        // the review pipeline can still see it.
        await prisma.world.update({
          where: { id: report.targetWorldId },
          data: { releaseStatus: 0 },
        });
        await audit("world.unpublish", {
          actorId: admin.sub,
          subjectId: report.targetWorldId,
          detail: { reportId: report.id, reason },
        });
      }

      await prisma.report.update({
        where: { id: report.id },
        data: {
          status: decision,
          resolvedById: admin.sub,
          resolutionNotes: notes,
          resolvedAt: new Date(),
        },
      });
      await audit("report.resolve", {
        actorId: admin.sub,
        subjectId: report.targetUserId ?? report.targetWorldId,
        detail: { reportId: report.id, decision, notes },
      });
      return { status: "resolved", decision: body.decision };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        decision: t.String(),
        notes: t.Optional(t.String()),
        warn: t.Optional(t.Boolean()),
        platformBan: t.Optional(t.Boolean()),
        unpublishWorld: t.Optional(t.Boolean()),
      }),
    },
  );
