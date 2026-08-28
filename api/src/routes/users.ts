import { Elysia, t } from "elysia";
import { prisma, redis } from "../db.ts";
import { authed } from "../auth-plugin.ts";

/// Public user profile by username. No auth required — this is what /profile/[username] on
/// the web consumes. Returns enough info for a profile page without exposing sensitive data.
export const publicUserRoutes = new Elysia({ prefix: "/v1/users" })
  .get(
    "/:username",
    async ({ params, set }) => {
      const user = await prisma.user.findUnique({
        where: { username: params.username },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
          isPremium: true,
          trustLevel: true,
          createdAt: true,
          authoredWorlds: {
            where: { releaseStatus: { gte: 1 } },
            select: { id: true, name: true, description: true, tags: true, heat: true, visitCount: true },
            orderBy: { heat: "desc" },
            take: 12,
          },
          authoredAvatars: {
            where: { releaseStatus: { gte: 1 } },
            select: { id: true, name: true },
            take: 12,
          },
        },
      });
      if (!user) {
        set.status = 404;
        return { error: "user_not_found" };
      }

      const [followerCount, followingCount, worldCount] = await Promise.all([
        prisma.follow.count({ where: { followedId: user.id } }),
        prisma.follow.count({ where: { followerId: user.id } }),
        prisma.world.count({ where: { authorId: user.id, releaseStatus: { gte: 1 } } }),
      ]);

      const online = (await redis.sismember("online:users", user.id)) === 1;

      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isPremium: user.isPremium,
        trustLevel: user.trustLevel,
        createdAt: user.createdAt,
        online,
        stats: {
          followers: followerCount,
          following: followingCount,
          worlds: worldCount,
        },
        worlds: user.authoredWorlds.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description,
          tags: w.tags,
          heat: w.heat,
          visitCount: Number(w.visitCount),
        })),
        avatars: user.authoredAvatars,
      };
    },
    { params: t.Object({ username: t.String() }) },
  )
  /// Minimal card by user *id*. The relay only carries a peer's account id, so this is how the
  /// game turns that into a display name + profile picture for the floating name tag. Public and
  /// read-only, and deliberately tiny — never expand it into the full profile above.
  .get(
    "/by-id/:id/card",
    async ({ params, set }) => {
      const user = await prisma.user.findUnique({
        where: { id: params.id },
        select: { id: true, username: true, displayName: true, avatarUrl: true, trustLevel: true },
      });
      if (!user) {
        set.status = 404;
        return { error: "user_not_found" };
      }
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        trustLevel: user.trustLevel,
      };
    },
    { params: t.Object({ id: t.String() }) },
  );

/// Authed user profile routes — follow status, block status, etc.
export const authedUserRoutes = new Elysia({ prefix: "/v1/users" })
  .use(authed)
  // Check if I follow / block / friend a specific user (for profile page button state).
  .get(
    "/:username/relationship",
    async ({ session, params, set }) => {
      const target = await prisma.user.findUnique({ where: { username: params.username } });
      if (!target) {
        set.status = 404;
        return { error: "user_not_found" };
      }
      // Friend rows are keyed with userA < userB — sort the pair before looking up.
      const [a, b] = [session.sub, target.id].sort();
      const [following, blocked, friend] = await Promise.all([
        prisma.follow.findUnique({
          where: { followerId_followedId: { followerId: session.sub, followedId: target.id } },
        }),
        prisma.block.findUnique({
          where: { userId_blockedId: { userId: session.sub, blockedId: target.id } },
        }),
        prisma.friend.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } }),
      ]);
      return {
        following: !!following,
        blocked: !!blocked,
        isSelf: target.id === session.sub,
        friend: friend?.status === 1,
        // They sent the request (awaiting MY accept) vs I sent it (awaiting THEIRS).
        incomingRequest: friend?.status === 0 && friend.requestedById !== session.sub,
        outgoingRequest: friend?.status === 0 && friend.requestedById === session.sub,
      };
    },
    { params: t.Object({ username: t.String() }) },
  );
