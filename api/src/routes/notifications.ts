import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { prisma } from "../db.ts";
import { serialize } from "../notify.ts";

/// The notification inbox. Durable per-user list, unread counts, and read/dismiss actions.
///
/// The gateway pushes new notifications live, but this is what makes them survive being offline —
/// the client fetches here on connect and on reconnect, and the push is only a fast path.
export const notificationRoutes = new Elysia({ prefix: "/v1/notifications" })
  .use(authed)

  /// List notifications, newest first. `unreadOnly` powers the badge-driven views.
  .get(
    "/",
    async ({ session, query }) => {
      const take = Math.min(Math.max(Number(query.limit ?? 50), 1), 100);
      const unreadOnly = query.unreadOnly === "true";

      const [items, unread] = await Promise.all([
        prisma.notification.findMany({
          where: {
            userId: session.sub,
            ...(unreadOnly ? { readAt: null } : {}),
            ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
          },
          include: {
            actor: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
          },
          orderBy: { createdAt: "desc" },
          take,
        }),
        prisma.notification.count({ where: { userId: session.sub, readAt: null } }),
      ]);

      return { notifications: items.map(serialize), unread };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        unreadOnly: t.Optional(t.String()),
        before: t.Optional(t.String()),
      }),
    },
  )

  /// Just the badge number. Cheap enough to poll as a fallback when the socket is down.
  .get("/unread", async ({ session }) => ({
    unread: await prisma.notification.count({ where: { userId: session.sub, readAt: null } }),
  }))

  /// Mark one read. Scoped by userId in the `updateMany` filter so a guessed id touches nothing.
  .post(
    "/:id/read",
    async ({ session, params }) => {
      const { count } = await prisma.notification.updateMany({
        where: { id: params.id, userId: session.sub, readAt: null },
        data: { readAt: new Date() },
      });
      const unread = await prisma.notification.count({ where: { userId: session.sub, readAt: null } });
      return { updated: count, unread };
    },
    { params: t.Object({ id: t.String() }) },
  )

  /// Mark everything read — the "clear the badge" action.
  .post("/read-all", async ({ session }) => {
    const { count } = await prisma.notification.updateMany({
      where: { userId: session.sub, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count, unread: 0 };
  })

  /// Delete one.
  .delete(
    "/:id",
    async ({ session, params }) => {
      const { count } = await prisma.notification.deleteMany({
        where: { id: params.id, userId: session.sub },
      });
      const unread = await prisma.notification.count({ where: { userId: session.sub, readAt: null } });
      return { deleted: count, unread };
    },
    { params: t.Object({ id: t.String() }) },
  )

  /// Clear the whole inbox.
  .delete("/", async ({ session }) => {
    const { count } = await prisma.notification.deleteMany({ where: { userId: session.sub } });
    return { deleted: count, unread: 0 };
  });
