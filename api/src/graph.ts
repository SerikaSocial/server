import { config } from "./config.ts";
import { prisma } from "./db.ts";

/// Best-effort write-through to the canonical graph on serika-accounts.
/// Failures are logged, never thrown — Social remains usable if accounts is down.
async function accountsGraph(method: string, path: string, body?: unknown): Promise<void> {
  try {
    const res = await fetch(`${config.accounts.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-service-key": config.accounts.internalKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) console.error(`[graph] ${method} ${path} -> ${res.status}`);
  } catch (e) {
    console.error(`[graph] ${method} ${path} failed`, e);
  }
}

async function accountsId(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { accountsId: true } });
  return u?.accountsId ?? null;
}

export async function syncFriend(aUserId: string, bUserId: string, requestedByUserId: string, status?: number) {
  const [a, b, requestedBy] = await Promise.all([accountsId(aUserId), accountsId(bUserId), accountsId(requestedByUserId)]);
  if (!a || !b || !requestedBy) return;
  await accountsGraph("POST", "/internal/graph/friends", { a, b, requestedBy, status });
}

export async function unsyncFriend(aUserId: string, bUserId: string) {
  const [a, b] = await Promise.all([accountsId(aUserId), accountsId(bUserId)]);
  if (!a || !b) return;
  await accountsGraph("DELETE", "/internal/graph/friends", { a, b });
}

export async function syncFollow(followerUserId: string, followedUserId: string) {
  const [follower, followed] = await Promise.all([accountsId(followerUserId), accountsId(followedUserId)]);
  if (!follower || !followed) return;
  await accountsGraph("POST", "/internal/graph/follow", { follower, followed });
}

export async function unsyncFollow(followerUserId: string, followedUserId: string) {
  const [follower, followed] = await Promise.all([accountsId(followerUserId), accountsId(followedUserId)]);
  if (!follower || !followed) return;
  await accountsGraph("DELETE", "/internal/graph/follow", { follower, followed });
}
