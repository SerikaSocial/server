import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { prisma, redis, keys } from "../db.ts";
import { canInviteToInstance, worldJoinGate } from "../instance-access.ts";
import { notify } from "../notify.ts";

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

      // Durable notification + live push. This used to be a bare `redis.publish`, which reached
      // the target only if they happened to be connected at that instant — a friend request sent
      // to an offline user vanished with no trace anywhere.
      try {
        const me = await prisma.user.findUnique({
          where: { id: session.sub },
          select: { username: true, displayName: true },
        });
        const who = me?.displayName || me?.username || "Someone";
        await notify({
          userId: target.id,
          kind: "friend_request",
          actorId: session.sub,
          title: "Friend request",
          body: `${who} wants to be friends.`,
          data: { userId: session.sub, username: me?.username },
        });
      } catch (e) { console.error("[social] friend_request notify failed", e); }

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

      // Tell the requester their request landed — otherwise the only way to find out is to
      // notice the person has silently appeared in your friends list.
      try {
        const me = await prisma.user.findUnique({
          where: { id: session.sub },
          select: { username: true, displayName: true },
        });
        const who = me?.displayName || me?.username || "Someone";
        await notify({
          userId: params.userId,
          kind: "friend_accepted",
          actorId: session.sub,
          title: "Friend request accepted",
          body: `${who} accepted your friend request.`,
          data: { userId: session.sub, username: me?.username },
        });
      } catch (e) { console.error("[social] friend_accepted notify failed", e); }

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
  )

  // ── Invites ────────────────────────────────────────────────────────────
  //
  // There was no invite endpoint at all before this. The gateway had `/internal/invite` and the
  // client had a "Copy invite link" button that put a deep link on the clipboard — but nothing
  // ever called the gateway, and no route existed for one user to invite another. "Inviting to a
  // world doesn't work" was not a bug in the delivery path; the feature had no server half.

  /// Invite someone to the instance you are currently in.
  ///
  /// Who may invite whom is deliberately narrow: friends, or someone who is in the same instance
  /// as you right now. An open invite endpoint is a spam vector aimed at a modal dialog, and the
  /// server is the only place that can enforce it.
  .post(
    "/invite",
    async ({ session, body, set }) => {
      if (body.targetUserId === session.sub) {
        set.status = 400;
        return { error: "cannot_invite_self" };
      }

      const target = await prisma.user.findUnique({
        where: { id: body.targetUserId },
        select: { id: true, username: true },
      });
      if (!target) {
        set.status = 404;
        return { error: "user_not_found" };
      }

      // Blocks are mutual and checked in both directions.
      const blocked = await prisma.block.findFirst({
        where: {
          OR: [
            { userId: session.sub, blockedId: target.id },
            { userId: target.id, blockedId: session.sub },
          ],
        },
      });
      if (blocked) {
        set.status = 403;
        return { error: "blocked" };
      }

      // Rate limit: a burst of invites is a burst of modal popups on someone else's screen.
      const rlKey = `invite:rate:${session.sub}`;
      const count = await redis.incr(rlKey).catch(() => 0);
      if (count === 1) await redis.expire(rlKey, 60).catch(() => {});
      if (count > 10) {
        set.status = 429;
        return { error: "rate_limited", retryAfter: 60 };
      }

      const instance = await prisma.instance.findFirst({
        where: { id: body.instanceId, closedAt: null },
        include: { world: true },
      });
      if (!instance) {
        set.status = 404;
        return { error: "instance_not_found" };
      }

      // Only occupants can invite; private rooms reserve this to their owner. Without
      // this check a friend could invite someone into any guessed private instance.
      if (!await canInviteToInstance(instance, session.sub)) {
        set.status = 403; return { error: "not_permitted", detail: "Only the host can invite to a private instance." };
      }
      if (await worldJoinGate(instance.world, target.id)) {
        set.status = 403; return { error: "not_published" };
      }

      // Permission: friends, or co-located in this instance right now.
      const [a, b] = [session.sub, target.id].sort();
      const friendship = await prisma.friend.findUnique({
        where: { userAId_userBId: { userAId: a, userBId: b } },
      });
      const areFriends = friendship?.status === 1;

      let coLocated = false;
      if (!areFriends) {
        const roster = await redis.hkeys(keys.instanceRoster(instance.id)).catch(() => [] as string[]);
        coLocated = roster.includes(session.sub) && roster.includes(target.id);
      }
      if (!areFriends && !coLocated) {
        set.status = 403;
        return { error: "not_permitted", detail: "invite friends, or people in your instance" };
      }

      const me = await prisma.user.findUnique({
        where: { id: session.sub },
        select: { username: true, displayName: true },
      });
      const who = me?.displayName || me?.username || "Someone";

      // 15 minutes. Long enough to notice, short enough that the instance probably still exists.
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      const row = await notify({
        userId: target.id,
        kind: "invite",
        actorId: session.sub,
        title: `${who} invited you`,
        body: `Join them in ${instance.world.name}.`,
        link: `serikasocial://world/${instance.world.id}`,
        data: {
          worldId: instance.world.id,
          worldName: instance.world.name,
          instanceId: instance.id,
          access: instance.access,
          fromUserId: session.sub,
          fromUsername: me?.username,
        },
        expiresAt,
      });

      return { status: "sent", notificationId: row.id, expiresAt: expiresAt.toISOString() };
    },
    {
      body: t.Object({
        targetUserId: t.String(),
        instanceId: t.String(),
      }),
    },
  );
