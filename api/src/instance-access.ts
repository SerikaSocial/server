import { prisma, redis, keys } from "./db.ts";
import { PUBLISHED_STATES } from "./review.ts";

export const InstanceAccess = { Public: 0, Friends: 1, FriendsOfFriends: 2, Invite: 3, Private: 4 } as const;
type Instance = { id: string; ownerId: string | null; access: number; closedAt: Date | null; eventId?: string | null };

export async function blockedBetween(a: string, b: string) {
  return !!await prisma.block.findFirst({ where: { OR: [
    { userId: a, blockedId: b }, { userId: b, blockedId: a },
  ] } });
}

export async function areFriends(a: string, b: string) {
  const [userAId, userBId] = [a, b].sort();
  const friend = await prisma.friend.findUnique({ where: { userAId_userBId: { userAId: userAId!, userBId: userBId! } } });
  return friend?.status === 1;
}

/** Public browsing, direct joins, and invitations share one backend authorization policy.
 * A guessed ID or a forwarded link is never a private-instance access grant. */
export async function canAccessInstance(instance: Instance, userId: string): Promise<boolean> {
  if (instance.closedAt) return false;
  if (instance.eventId) {
    const event = await prisma.liveEvent.findUnique({ where: { id: instance.eventId }, select: { status: true } });
    if (!event || !["open", "live"].includes(event.status)) return false;
  }
  if (instance.ownerId === userId) return true;
  if (instance.access === InstanceAccess.Public) return true;
  if (!instance.ownerId || await blockedBetween(instance.ownerId, userId)) return false;
  if (instance.access === InstanceAccess.Friends) return areFriends(instance.ownerId, userId);
  if (instance.access === InstanceAccess.FriendsOfFriends) {
    if (await areFriends(instance.ownerId, userId)) return true;
    const friends = await prisma.friend.findMany({ where: {
      status: 1, OR: [{ userAId: instance.ownerId }, { userBId: instance.ownerId }],
    }, select: { userAId: true, userBId: true } });
    for (const friend of friends) {
      const other = friend.userAId === instance.ownerId ? friend.userBId : friend.userAId;
      if (await areFriends(other, userId)) return true;
    }
    return false;
  }
  if (instance.access !== InstanceAccess.Invite && instance.access !== InstanceAccess.Private) return false;
  // A recipient already connected need not lose access when their invite times out.
  if (await redis.hexists(keys.instanceRoster(instance.id), userId)) return true;
  return !!await prisma.notification.findFirst({ where: {
    userId, kind: "invite", expiresAt: { gt: new Date() },
    ...(instance.access === InstanceAccess.Private ? { actorId: instance.ownerId } : {}),
    data: { path: ["instanceId"], equals: instance.id },
  }, select: { id: true } });
}

export async function canInviteToInstance(instance: Instance, userId: string): Promise<boolean> {
  if (!await canAccessInstance(instance, userId)) return false;
  if (instance.access === InstanceAccess.Private) return instance.ownerId === userId;
  return instance.ownerId === userId || !!await redis.hexists(keys.instanceRoster(instance.id), userId);
}

export async function worldJoinGate(world: {
  id: string; authorId: string | null; publishedVersionId: string | null; isBuiltin: boolean; releaseStatus: number; eventOnly?: boolean;
}, userId: string, privatePreview = false, eventAdmission = false): Promise<string | null> {
  // Author/admin previews must be deliberately private, never public matchmaking.
  if (privatePreview && world.authorId === userId) return null;
  if (privatePreview) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (user?.isAdmin) return null;
  }
  if (world.eventOnly && !eventAdmission) return "event_join_required";
  if (world.releaseStatus < 1 || !world.publishedVersionId) return "not_published";
  const published = await prisma.worldVersion.findUnique({ where: { id: world.publishedVersionId },
    select: { worldId: true, buildStatus: true, reviewStatus: true } });
  if (!published || published.worldId !== world.id || published.buildStatus !== 2 || !PUBLISHED_STATES.has(published.reviewStatus)) return "not_published";
  return null;
}
