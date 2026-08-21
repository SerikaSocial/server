import { Elysia } from "elysia";
import { verifySession, type SessionClaims } from "./tokens.ts";

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
      return { session };
    } catch {
      set.status = 401;
      throw new Error("invalid session token");
    }
  },
);
