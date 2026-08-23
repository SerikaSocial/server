import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { prisma, redis, keys } from "../db.ts";

/// Friends, blocks, and social surface. M7.
export const friendRoutes = new Elysia({ prefix: "/v1/social" })
  .use(authed)

  // ── Friends ──────────────────────────────────────────────────────────────

  // List friends (accepted) and pending requests.
  .get("/friends", async ({ session }) => {
    const [accepted, pending] = await Promise.all([
      prisma.friend.findMany({
        where: {
          OR: [{ userAId: session.sub }, { userBId: session.sub }],
          status: 1,
        },
        include: {
          userA: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          userB: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      }),
      prisma.friend.findMany({
        where: {
          OR: [{ userAId: session.sub }, { userBId: session.sub }],
          status: 0,
        },
        include: {
          userA: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          userB: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
        },
      }),
    ]);

    const friends = accepted.map((f) => {
      const other = f.userAId === session.sub ? f.userB : f.userA;
      return { id: other.id, username: other.username, displayName: other.displayName, avatarUrl: other.avatarUrl };
    });

    const incoming = pending
      .filter((f) => f.requestedById !== session.sub)
      .map((f) => {
        const other = f.userAId === session.sub ? f.userB : f.userA;
        return { id: other.id, username: other.username, displayName: other.displayName, avatarUrl: other.avatarUrl };
      });

    const outgoing = pending
      .filter((f) => f.requestedById === session.sub)
      .map((f) => {
        const other = f.userAId === session.sub ? f.userB : f.userA;
        return { id: other.id, username: other.username, displayName: other.displayName, avatarUrl: other.avatarUrl };
      });

    return { friends, incoming, outgoing };
  })

  // Send a friend request.
  .post(
    "/friends/:userId",
    async ({ session, params, set }) => {
      const target = await prisma.user.findUnique({ where: { id: params.userId } });
      if (!target) {
        set.status = 404;
        return { error: "user_not_found" };
      }
      if (target.id === session.sub) {
        set.status = 400;
        return { error: "cannot_friend_self" };
      }

      // Check if already friends or request pending.
      const [a, b] = [session.sub, target.id].sort();
      const existing = await prisma.friend.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } });
      if (existing) {
        if (existing.status === 1) return { error: "already_friends" };
        if (existing.requestedById === session.sub) return { error: "request_already_sent" };
        // They already sent us a request — auto-accept.
        await prisma.friend.update({
          where: { userAId_userBId: { userAId: a, userBId: b } },
          data: { status: 1 },
        });
        return { status: "accepted" };
      }

      // Check block
      const blocked = await prisma.block.findFirst({
        where: { OR: [{ userId: session.sub, blockedId: target.id }, { userId: target.id, blockedId: session.sub }] },
      });
      if (blocked) {
        set.status = 403;
        return { error: "blocked" };
      }

      await prisma.friend.create({
        data: { userAId: a, userBId: b, requestedById: session.sub, status: 0 },
      });

      // Push notification to the target via gateway.
      try {
        const { username } = (await prisma.user.findUnique({ where: { id: session.sub }, select: { username: true } }))!;
        await redis.publish(`gwpush:${target.id}`, JSON.stringify({
          type: "friend_request",
          from: { id: session.sub, username },
        }));
      } catch { /* push is best-effort */ }

      return { status: "pending" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // Accept a friend request.
  .post(
    "/friends/:userId/accept",
    async ({ session, params, set }) => {
      const [a, b] = [session.sub, params.userId].sort();
      const existing = await prisma.friend.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } });
      if (!existing || existing.status !== 0 || existing.requestedById === session.sub) {
        set.status = 404;
        return { error: "request_not_found" };
      }
      await prisma.friend.update({
        where: { userAId_userBId: { userAId: a, userBId: b } },
        data: { status: 1 },
      });
      return { status: "accepted" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // Remove a friend or decline a request.
  .delete(
    "/friends/:userId",
    async ({ session, params }) => {
      const [a, b] = [session.sub, params.userId].sort();
      await prisma.friend.deleteMany({ where: { userAId: a, userBId: b } });
      return { status: "removed" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // ── Blocks ──────────────────────────────────────────────────────────────

  .post(
    "/block/:userId",
    async ({ session, params }) => {
      await prisma.block.upsert({
        where: { userId_blockedId: { userId: session.sub, blockedId: params.userId } },
        create: { userId: session.sub, blockedId: params.userId },
        update: {},
      });
      // Remove any friendship.
      const [a, b] = [session.sub, params.userId].sort();
      await prisma.friend.deleteMany({ where: { userAId: a, userBId: b } });
      return { status: "blocked" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  .delete(
    "/block/:userId",
    async ({ session, params }) => {
      await prisma.block.deleteMany({ where: { userId: session.sub, blockedId: params.userId } });
      return { status: "unblocked" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // List users I've blocked — the client fetches this to show beans for blocked users in-world.
  .get("/blocks", async ({ session }) => {
    const blocks = await prisma.block.findMany({
      where: { userId: session.sub },
      select: {
        blocked: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    return { blocks: blocks.map((b) => b.blocked) };
  })

  // ── Follows (Twitter-style, asymmetric) ──────────────────────────────────

  // Follow a user.
  .post(
    "/follow/:userId",
    async ({ session, params, set }) => {
      if (params.userId === session.sub) {
        set.status = 400;
        return { error: "cannot_follow_self" };
      }
      const target = await prisma.user.findUnique({ where: { id: params.userId } });
      if (!target) {
        set.status = 404;
        return { error: "user_not_found" };
      }
      await prisma.follow.upsert({
        where: { followerId_followedId: { followerId: session.sub, followedId: params.userId } },
        create: { followerId: session.sub, followedId: params.userId },
        update: {},
      });
      return { status: "following" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // Unfollow a user.
  .delete(
    "/follow/:userId",
    async ({ session, params }) => {
      await prisma.follow.deleteMany({
        where: { followerId: session.sub, followedId: params.userId },
      });
      return { status: "unfollowed" };
    },
    { params: t.Object({ userId: t.String() }) },
  )

  // List who I'm following.
  .get("/following", async ({ session }) => {
    const follows = await prisma.follow.findMany({
      where: { followerId: session.sub },
      select: {
        followed: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    return { following: follows.map((f) => f.followed) };
  })

  // List who follows me.
  .get("/followers", async ({ session }) => {
    const follows = await prisma.follow.findMany({
      where: { followedId: session.sub },
      select: {
        follower: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });
    return { followers: follows.map((f) => f.follower) };
  })

  // ── User search ──────────────────────────────────────────────────────────

  .get(
    "/users/search",
    async ({ session, query }) => {
      const q = query.q?.trim();
      if (!q || q.length < 2) return { users: [] };
      const users = await prisma.user.findMany({
        where: {
          username: { contains: q, mode: "insensitive" },
          id: { not: session.sub },
        },
        select: { id: true, username: true, displayName: true, avatarUrl: true },
        take: 20,
      });

      // Check which are online
      const ids = users.map((u) => u.id);
      const onlineFlags = ids.length > 0 ? await redis.smismember(keys.onlineUsers, ...ids) : [];
      return {
        users: users.map((u, i) => ({
          ...u,
          online: onlineFlags[i] === 1,
        })),
      };
    },
    { query: t.Object({ q: t.Optional(t.String()) }) },
  )

  // ── Favorites ──────────────────────────────────────────────────────────

  .post(
    "/favorites",
    async ({ session, body }) => {
      await prisma.favorite.upsert({
        where: {
          userId_kind_targetId: { userId: session.sub, kind: body.kind, targetId: body.targetId },
        },
        create: { userId: session.sub, kind: body.kind, targetId: body.targetId },
        update: {},
      });
      return { status: "favorited" };
    },
    { body: t.Object({ kind: t.Number(), targetId: t.String() }) },
  )

  .delete(
    "/favorites/:kind/:targetId",
    async ({ session, params }) => {
      await prisma.favorite.deleteMany({
        where: { userId: session.sub, kind: parseInt(params.kind), targetId: params.targetId },
      });
      return { status: "removed" };
    },
    { params: t.Object({ kind: t.String(), targetId: t.String() }) },
  );
