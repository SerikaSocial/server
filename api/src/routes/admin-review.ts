import { Elysia, t } from "elysia";
import { prisma } from "../db.ts";
import { adminOnly } from "../auth-plugin.ts";
import { place } from "../allocator.ts";
import { mintTicket } from "./instances.ts";
import { audit } from "../audit.ts";
import { ReviewStatus, REVIEW_LABELS, PUBLISHED_STATES } from "../review.ts";
import { trustLabel } from "../trust.ts";

// Admin review console. Forces manual review of code-bearing worlds that below-top-rank authors
// submitted, and surfaces top-rank scripted self-publishes for post-hoc spot audit.
export const adminReviewRoutes = new Elysia({ prefix: "/v1/admin/review" })
  .use(adminOnly)

  // ── Queue ────────────────────────────────────────────────────────────────
  // status: in_review | submitted (default both non-terminal); scripted: filter.
  .get(
    "/queue",
    async ({ query }) => {
      const statuses: number[] = query.status === "in_review" ? [ReviewStatus.InReview]
        : query.status === "submitted" ? [ReviewStatus.Submitted]
        : [ReviewStatus.InReview, ReviewStatus.Submitted];
      const where: any = { reviewStatus: { in: statuses } };
      if (query.scripted === "true") where.hasScript = true;
      if (query.scripted === "false") where.hasScript = false;

      const versions = await prisma.worldVersion.findMany({
        where,
        orderBy: { createdAt: "asc" }, // oldest first — highest SLA age at the top
        take: 100,
        include: { world: { include: { author: { select: { id: true, username: true, displayName: true, trustLevel: true } } } } },
      });

      const now = Date.now();
      return {
        queue: versions.map((v) => ({
          versionId: v.id,
          worldId: v.worldId,
          worldName: v.world.name,
          hasScript: v.hasScript,
          reviewStatus: v.reviewStatus,
          reviewStatusLabel: REVIEW_LABELS[v.reviewStatus],
          submittedAt: v.createdAt,
          ageMs: now - v.createdAt.getTime(),
          validatorOk: (v.validatorReport as any)?.ok ?? null,
          author: v.world.author && {
            id: v.world.author.id,
            username: v.world.author.username,
            displayName: v.world.author.displayName,
            trustLevel: v.world.author.trustLevel,
            trustLabel: trustLabel(v.world.author.trustLevel),
          },
        })),
      };
    },
    { query: t.Object({ status: t.Optional(t.String()), scripted: t.Optional(t.String()) }) },
  )

  // ── Spot-audit list ──────────────────────────────────────────────────────
  // Top-rank scripted self-publishes that went live without human review.
  .get("/spot-audit", async () => {
    const rows = await prisma.worldReview.findMany({
      where: { selfPublish: true },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { version: { include: { world: { select: { id: true, name: true, releaseStatus: true } } } } },
    });
    return {
      items: rows.map((r) => ({
        reviewId: r.id,
        versionId: r.worldVersionId,
        worldId: r.version.world.id,
        worldName: r.version.world.name,
        live: r.version.world.releaseStatus >= 1 && PUBLISHED_STATES.has(r.version.reviewStatus),
        publishedAt: r.createdAt,
      })),
    };
  })

  // ── Detail ─────────────────────────────────────────────────────────────────
  .get(
    "/world-version/:id",
    async ({ params, set }) => {
      const v = await prisma.worldVersion.findUnique({
        where: { id: params.id },
        include: {
          assets: true,
          reviews: { orderBy: { createdAt: "desc" } },
          world: { include: { author: { select: { id: true, username: true, displayName: true, trustLevel: true, isAdmin: true } } } },
        },
      });
      if (!v) { set.status = 404; return { error: "not_found" }; }

      // Author track record: prior rejections + any moderation actions against them.
      let history: any = null;
      if (v.world.author) {
        const [priorReviews, mods] = await Promise.all([
          prisma.worldReview.findMany({
            where: { version: { world: { authorId: v.world.author.id } } },
            orderBy: { createdAt: "desc" }, take: 20,
          }),
          prisma.moderationAction.findMany({ where: { targetId: v.world.author.id }, orderBy: { createdAt: "desc" }, take: 20 }),
        ]);
        history = {
          priorDecisions: priorReviews.map((r) => ({ decision: r.decision, notes: r.notes, at: r.createdAt })),
          moderation: mods.map((m) => ({ kind: m.kind, reason: m.reason, at: m.createdAt })),
        };
      }

      return {
        versionId: v.id,
        worldId: v.worldId,
        worldName: v.world.name,
        description: v.world.description,
        tags: v.world.tags,
        hasScript: v.hasScript,
        reviewStatus: v.reviewStatus,
        reviewStatusLabel: REVIEW_LABELS[v.reviewStatus],
        reviewNotes: v.reviewNotes,
        validatorReport: v.validatorReport,
        assets: v.assets.map((a) => ({ platform: a.platform, bytes: Number(a.bytes), cdnKey: a.cdnKey })),
        author: v.world.author && {
          id: v.world.author.id, username: v.world.author.username, displayName: v.world.author.displayName,
          trustLevel: v.world.author.trustLevel, trustLabel: trustLabel(v.world.author.trustLevel), isAdmin: v.world.author.isAdmin,
        },
        history,
        decisions: v.reviews.map((r) => ({ id: r.id, reviewerId: r.reviewerId, decision: r.decision, notes: r.notes, selfPublish: r.selfPublish, at: r.createdAt })),
      };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // ── Isolated preview ──────────────────────────────────────────────────────
  // Launch the submission (its own version, not the published one) in a private review
  // instance and mint a single-use ticket for the reviewer.
  .get(
    "/world-version/:id/preview-ticket",
    async ({ admin, params, set }) => {
      const v = await prisma.worldVersion.findUnique({ where: { id: params.id }, include: { world: true } });
      if (!v) { set.status = 404; return { error: "not_found" }; }

      const placement = await place({ capacity: 1, forceDedicated: false });
      if (!placement) { set.status = 503; return { error: "no_relay_available" }; }

      const instance = await prisma.instance.create({
        data: {
          worldId: v.worldId,
          worldVersionId: v.id, // the *submission* version, hardened review sandbox
          ownerId: admin.sub,
          access: 1, // private
          mode: placement.mode,
          nodeId: placement.nodeId,
          endpoint: placement.endpoint,
          capacity: 1,
        },
      });
      const ticket = await mintTicket(instance.id, admin.sub);
      if (!ticket) { set.status = 500; return { error: "ticket_failed" }; }

      await audit("world.review_preview", { actorId: admin.sub, subjectId: v.id });
      return { instanceId: instance.id, endpoint: instance.endpoint, worldName: v.world.name, review: true, ...ticket };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // ── Decision ──────────────────────────────────────────────────────────────
  // decision: approve | reject | request_changes. Approve publishes the version.
  .post(
    "/world-version/:id/decision",
    async ({ admin, params, body, set }) => {
      const v = await prisma.worldVersion.findUnique({ where: { id: params.id }, include: { world: true } });
      if (!v) { set.status = 404; return { error: "not_found" }; }

      const map = { approve: 0, reject: 1, request_changes: 2 } as const;
      const decisionCode = map[body.decision];
      if ((body.decision === "reject" || body.decision === "request_changes") && !body.notes?.trim()) {
        set.status = 400; return { error: "notes_required" };
      }

      const nextStatus = body.decision === "approve" ? ReviewStatus.Approved
        : body.decision === "reject" ? ReviewStatus.Rejected
        : ReviewStatus.ChangesRequested;

      await prisma.$transaction([
        prisma.worldReview.create({
          data: { worldVersionId: v.id, reviewerId: admin.sub, decision: decisionCode, notes: body.notes ?? "" },
        }),
        prisma.worldVersion.update({
          where: { id: v.id },
          data: { reviewStatus: nextStatus, reviewedById: admin.sub, reviewedAt: new Date(), reviewNotes: body.notes ?? "" },
        }),
      ]);

      // Approve → publish this version (no downtime: only flip the pointer on approve).
      if (body.decision === "approve") {
        await prisma.world.update({
          where: { id: v.worldId },
          data: { publishedVersionId: v.id, releaseStatus: 2 },
        });
        await audit("world.publish", { actorId: admin.sub, subjectId: v.id, detail: { via: "review" } });
      }

      await audit(`world.review.${body.decision}`, { actorId: admin.sub, subjectId: v.id, detail: { notes: body.notes ?? "" } });
      return { ok: true, versionId: v.id, reviewStatus: nextStatus, reviewStatusLabel: REVIEW_LABELS[nextStatus] };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        decision: t.Union([t.Literal("approve"), t.Literal("reject"), t.Literal("request_changes")]),
        notes: t.Optional(t.String({ maxLength: 4000 })),
      }),
    },
  )

  // ── Spot-audit takedown ────────────────────────────────────────────────────
  // Unpublish an already-live (top-rank self-published) version after the fact.
  .post(
    "/world-version/:id/unpublish",
    async ({ admin, params, body, set }) => {
      const v = await prisma.worldVersion.findUnique({ where: { id: params.id }, include: { world: true } });
      if (!v) { set.status = 404; return { error: "not_found" }; }

      await prisma.$transaction([
        prisma.worldVersion.update({ where: { id: v.id }, data: { reviewStatus: ReviewStatus.Rejected, reviewedById: admin.sub, reviewedAt: new Date(), reviewNotes: body.reason } }),
        // If this was the published version, take the world private.
        ...(v.world.publishedVersionId === v.id
          ? [prisma.world.update({ where: { id: v.worldId }, data: { publishedVersionId: null, releaseStatus: 0 } })]
          : []),
        ...(body.demote != null
          ? [prisma.user.update({ where: { id: v.world.authorId! }, data: { trustLevel: body.demote } })]
          : []),
      ]);
      await audit("world.unpublish", { actorId: admin.sub, subjectId: v.id, detail: { reason: body.reason, demote: body.demote ?? null } });
      return { ok: true };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ reason: t.String({ minLength: 1, maxLength: 2000 }), demote: t.Optional(t.Integer({ minimum: 0, maximum: 8 })) }),
    },
  );
