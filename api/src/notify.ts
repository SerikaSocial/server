import { prisma, redis } from "./db.ts";

/// The kinds of notification the client knows how to render. Anything else falls back to a plain
/// title/body row, so adding a kind here is not a breaking change for older clients.
export type NotificationKind =
  | "friend_request"
  | "friend_accepted"
  | "invite"
  | "world_review"
  | "system";

export interface NotifyInput {
  /// Who receives it.
  userId: string;
  kind: NotificationKind;
  /// Who caused it, when a person did.
  actorId?: string | null;
  title: string;
  body?: string;
  /// Where tapping it goes — a `serikasocial://` deep link or a web route.
  link?: string | null;
  data?: Record<string, unknown> | null;
  /// Absolute expiry. Invites go stale; a join button for an instance that emptied hours ago is
  /// worse than no button.
  expiresAt?: Date | null;
}

/// Create a notification and push it to any live gateway socket.
///
/// **The database write is the delivery, not the push.** The gateway only reaches a user who
/// happens to be connected right now, which is exactly the case that does not need durability —
/// so a design that pushes without persisting drops every notification aimed at an offline user,
/// which is most of them. The push here is a latency optimisation over the client's own polling
/// and reconnect fetch; if it fails, the notification is still waiting in the table.
///
/// Never let a push failure fail the caller's request: adding a friend must succeed whether or
/// not Redis is reachable.
export async function notify(input: NotifyInput) {
  const row = await prisma.notification.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      actorId: input.actorId ?? null,
      title: input.title,
      body: input.body ?? "",
      link: input.link ?? null,
      data: (input.data ?? undefined) as never,
      expiresAt: input.expiresAt ?? null,
    },
    include: {
      actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
    },
  });

  const unread = await prisma.notification
    .count({ where: { userId: input.userId, readAt: null } })
    .catch(() => 0);

  try {
    await redis.publish(
      `gwpush:${input.userId}`,
      JSON.stringify({ type: "notification", notification: serialize(row), unread }),
    );
  } catch (e) {
    console.error("[notify] push failed (row is persisted)", e);
  }

  return row;
}

/// Wire shape shared by the push payload and the REST list, so the client has exactly one
/// notification parser rather than one per transport.
export function serialize(n: {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  data: unknown;
  expiresAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
  actor?: { id: string; username: string; displayName: string | null; avatarUrl: string | null } | null;
}) {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    link: n.link,
    data: n.data ?? null,
    actor: n.actor
      ? {
          id: n.actor.id,
          username: n.actor.username,
          displayName: n.actor.displayName,
          avatarUrl: n.actor.avatarUrl,
        }
      : null,
    expiresAt: n.expiresAt?.toISOString() ?? null,
    read: n.readAt !== null,
    createdAt: n.createdAt.toISOString(),
  };
}
