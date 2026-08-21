import { Elysia } from "elysia";
import { verifySession, type SessionClaims } from "./tokens.ts";

/// Elysia plugin that resolves the caller from a Bearer session token and 401s if absent
/// or invalid. Routes that need a user apply `.use(authed)` and read `session` from context.
export const authed = new Elysia({ name: "authed" }).derive(
  { as: "scoped" },
  async ({ headers, set }): Promise<{ session: SessionClaims }> => {
    const auth = headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      set.status = 401;
      throw new Error("missing bearer token");
    }
    try {
      const session = await verifySession(auth.slice(7));
      return { session };
    } catch {
      set.status = 401;
      throw new Error("invalid session token");
    }
  },
);
