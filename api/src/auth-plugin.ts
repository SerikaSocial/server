import { Elysia } from "elysia";
import { verifySession, type SessionClaims } from "./tokens.ts";
import { prisma } from "./db.ts";

/// Elysia plugin that resolves the caller from a Bearer session token and 401s if absent
/// or invalid. Routes that need a user apply `.use(authed)` and read `session` from context.
export const authed = new Elysia({ name: "authed" }).derive(
  { as: "scoped" },
  async ({ headers, cookie, set }): Promise<{ session: SessionClaims }> => {
    // Accept either a Bearer token (game client) or the httpOnly cookie (web app).
    const auth = headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : cookie.serika_session?.value;
    if (!token) {
      set.status = 401;
      throw new Error("missing session token");
    }
    try {
      const session = await verifySession(token);
      if (!session || typeof session.sub !== "string" || !session.sub) {
        set.status = 401;
        throw new Error("invalid session token");
      }
      return { session };
    } catch (e) {
      set.status = 401;
      throw new Error(e instanceof Error ? e.message : "invalid session token");
    }
  },
);

/// Like `authed`, but additionally requires the caller to be an admin (users.is_admin). Used to
/// guard the admin panel routes (managing default avatars and the default Home world).
export const adminOnly = new Elysia({ name: "adminOnly" }).use(authed).derive(
  { as: "scoped" },
  async ({ session, set }): Promise<{ admin: SessionClaims }> => {
    if (!session || typeof session.sub !== "string" || !session.sub) {
      set.status = 401;
      throw new Error("invalid session token");
    }
    const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { isAdmin: true } });
    if (!user?.isAdmin) {
      set.status = 403;
      throw new Error("admin only");
    }
    return { admin: session };
  },
);
