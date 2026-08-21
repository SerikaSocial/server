import { Elysia, t } from "elysia";
import { exchangeCode, verifyOAuth, authorizeUrl } from "../accounts.ts";
import { upsertUser } from "../users.ts";
import { signSession } from "../tokens.ts";
import { authed } from "../auth-plugin.ts";
import { prisma } from "../db.ts";

export const sessionRoutes = new Elysia({ prefix: "/v1/session" })
  // Convenience for the client: hands back the authorize URL to open in a browser. The
  // client generates its own PKCE verifier/challenge and state.
  .get(
    "/authorize-url",
    ({ query }) => ({ url: authorizeUrl(query.state, query.code_challenge) }),
    { query: t.Object({ state: t.String(), code_challenge: t.String() }) },
  )

  // The heart of login. The client caught the code on its loopback listener and posts it
  // here with the PKCE verifier. We exchange it, verify (WITH ban check), mirror the user,
  // and issue our own session token.
  .post(
    "/exchange",
    async ({ body, set }) => {
      const token = await exchangeCode(body.code, body.code_verifier);
      if (!token) {
        set.status = 400;
        return { error: "code_exchange_failed" };
      }

      const result = await verifyOAuth(token.access_token);
      if (!result.valid || !result.user) {
        set.status = 403;
        // Surface a ban distinctly so the client can show the right message.
        return { error: result.code === "ACCOUNT_BANNED" ? "banned" : "verify_failed" };
      }

      const user = await upsertUser(result.user);
      const session = await signSession({
        sub: user.id,
        accountsId: user.accountsId,
        username: user.username,
        isAdmin: user.isAdmin,
      });

      return {
        session_token: session,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          isPremium: user.isPremium,
          currentAvatarId: user.currentAvatarId,
        },
      };
    },
    { body: t.Object({ code: t.String(), code_verifier: t.String() }) },
  )

  // Who am I. Requires a valid session token.
  .use(authed)
  .get("/me", async ({ session, set }) => {
    const user = await prisma.user.findUnique({ where: { id: session.sub } });
    if (!user) {
      set.status = 404;
      return { error: "not_found" };
    }
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      isPremium: user.isPremium,
      isAdmin: user.isAdmin,
      trustLevel: user.trustLevel,
      currentAvatarId: user.currentAvatarId,
    };
  });
