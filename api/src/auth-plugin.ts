import { Elysia } from "elysia";
import { verifySession, type SessionClaims } from "./tokens.ts";
import { prisma } from "./db.ts";

/// Resolves the caller from a Bearer session token (game client) or the httpOnly cookie
/// (web app). Shared by `authed` and `adminOnly` — the latter must NOT get it via
/// `.use(authed)`: a scoped derive only propagates ONE plugin level, and `adminOnly` has no
/// routes of its own, so authed's `session` never reached the route files that use adminOnly
/// and every admin endpoint 401'd with "invalid session token". Both plugins resolve
/// independently through this function instead.
async function resolveSession({
  headers,
  cookie,
  set,
}: {
  headers: Record<string, string | undefined>;
  cookie: Record<string, { value?: string } | undefined>;
  set: { status?: number };
}): Promise<SessionClaims> {
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
    return session;
  } catch (e) {
    set.status = 401;
    throw new Error(e instanceof Error ? e.message : "invalid session token");
  }
}

/// Elysia plugin that resolves the caller from a Bearer session token and 401s if absent
/// or invalid. Routes that need a user apply `.use(authed)` and read `session` from context.
export const authed = new Elysia({ name: "authed" }).derive(
  { as: "scoped" },
  async (ctx): Promise<{ session: SessionClaims }> => ({ session: await resolveSession(ctx) }),
);

/// Like `authed`, but additionally requires the caller to be an admin (users.is_admin). Used to
/// guard the admin panel routes (managing default avatars and the default Home world). Derives
/// `session` as well as `admin` so consumers can read either.
export const adminOnly = new Elysia({ name: "adminOnly" }).derive(
  { as: "scoped" },
  async (ctx): Promise<{ session: SessionClaims; admin: SessionClaims }> => {
    const session = await resolveSession(ctx);
    const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { isAdmin: true } });
    if (!user?.isAdmin) {
      ctx.set.status = 403;
      throw new Error("admin only");
    }
    return { session, admin: session };
  },
);
