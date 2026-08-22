import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { prisma } from "../db.ts";

const authorSelect = { id: true, username: true, displayName: true, avatarUrl: true } as const;

function serializeReview(r: any) {
  return {
    id: r.id,
    rating: r.rating,
    body: r.body,
    createdAt: r.createdAt,
    author: {
      id: r.user.id,
      username: r.user.username,
      displayName: r.user.displayName,
      avatarUrl: r.user.avatarUrl,
    },
  };
}

// ── Public: list reviews for a world ────────────────────────────────────────
export const reviewPublicRoutes = new Elysia({ prefix: "/v1/worlds" }).get(
  "/:id/reviews",
  async ({ params, headers, cookie }) => {
    // Resolve the caller if a session is present, so we can honour their blocks. The
    // route stays public — anonymous callers just get all reviews.
    let callerId: string | null = null;
    try {
      const auth = headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : cookie.serika_session?.value;
      if (typeof token === "string" && token.length > 0) {
        const { verifySession } = await import("../tokens.ts");
        const session = await verifySession(token);
        callerId = session.sub;
      }
    } catch {
      callerId = null;
    }

    let excludeUserIds: string[] = [];
    if (callerId) {
      const blocks = await prisma.block.findMany({
        where: { userId: callerId },
        select: { blockedId: true },
      });
      excludeUserIds = blocks.map((b) => b.blockedId);
    }

    const reviews = await prisma.review.findMany({
      where: {
        worldId: params.id,
        ...(excludeUserIds.length > 0 ? { userId: { notIn: excludeUserIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: { user: { select: authorSelect } },
    });

    // Summary is computed over the full set (unfiltered) so the average reflects the world.
    const agg = await prisma.review.aggregate({
      where: { worldId: params.id },
      _avg: { rating: true },
      _count: { _all: true },
    });
    const count = agg._count._all;
    const average = count > 0 ? Math.round((agg._avg.rating ?? 0) * 10) / 10 : 0;

    return {
      summary: { average, count },
      reviews: reviews.map(serializeReview),
    };
  },
  { params: t.Object({ id: t.String() }) },
);

// ── Authed: create/update and delete reviews ────────────────────────────────
export const reviewRoutes = new Elysia()
  .use(authed)

  .post(
    "/v1/worlds/:id/reviews",
    async ({ session, params, body, set }) => {
      const world = await prisma.world.findUnique({ where: { id: params.id }, select: { id: true } });
      if (!world) {
        set.status = 404;
        return { error: "world_not_found" };
      }

      const review = await prisma.review.upsert({
        where: { worldId_userId: { worldId: params.id, userId: session.sub } },
        create: { worldId: params.id, userId: session.sub, rating: body.rating, body: body.body },
        update: { rating: body.rating, body: body.body },
        include: { user: { select: authorSelect } },
      });

      return { ok: true, review: serializeReview(review) };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        rating: t.Integer({ minimum: 1, maximum: 5 }),
        body: t.String({ minLength: 1, maxLength: 1000 }),
      }),
    },
  )

  .delete(
    "/v1/reviews/:id",
    async ({ session, params, set }) => {
      const review = await prisma.review.findUnique({ where: { id: params.id }, select: { userId: true } });
      if (!review) {
        set.status = 404;
        return { error: "review_not_found" };
      }
      if (review.userId !== session.sub) {
        const caller = await prisma.user.findUnique({ where: { id: session.sub }, select: { isAdmin: true } });
        if (!caller?.isAdmin) {
          set.status = 403;
          return { error: "forbidden" };
        }
      }
      await prisma.review.delete({ where: { id: params.id } });
      return { ok: true };
    },
    { params: t.Object({ id: t.String() }) },
  );
