import { Elysia, t } from "elysia";
import { createHash, randomBytes } from "crypto";
import { redis } from "../db.ts";
import { exchangeCode, verifyOAuth } from "../accounts.ts";
import { upsertUser } from "../users.ts";
import { signSession } from "../tokens.ts";
import { config } from "../config.ts";

// Server-side OAuth for the web app. The browser never sees the code_verifier — the api
// generates it, stashes it in Redis keyed by `state`, and completes the exchange on the
// callback. This is the confidential-flow shape but still PKCE, so no client secret is
// needed (serika-social is a public client).

const base64url = (b: Buffer) => b.toString("base64url");

function webRedirectUri(): string {
  // Must exactly match a redirect registered for the serika-social client in
  // serika-accounts. In prod that's https://api-social.ado.ink/v1/web/callback.
  return `${config.accounts.webCallbackUrl}`;
}

export const webAuthRoutes = new Elysia({ prefix: "/v1/web" })
  // Kick off login: stash a PKCE verifier under `state`, then bounce to the provider.
  .get("/login", async ({ redirect }) => {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));

    await redis.set(`weblogin:${state}`, verifier, "EX", 600);

    const u = new URL(`${config.accounts.baseUrl}/api/oauth/authorize`);
    u.searchParams.set("client_id", "serika-social");
    u.searchParams.set("redirect_uri", webRedirectUri());
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "profile email");
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return redirect(u.toString());
  })

  // Provider redirect lands here. Exchange, verify (with ban check), mirror, hand off.
  .get(
    "/callback",
    async ({ query, redirect, set }) => {
      const verifier = await redis.get(`weblogin:${query.state}`);
      if (!verifier) {
        set.status = 400;
        return { error: "unknown_or_expired_state" };
      }
      await redis.del(`weblogin:${query.state}`);

      // Exchange with the SAME client_id and redirect_uri the web login used, not the game
      // client — the provider requires them to match the authorize request.
      const token = await exchangeCode(query.code, verifier, "serika-social", webRedirectUri());
      if (!token) {
        set.status = 400;
        return { error: "code_exchange_failed" };
      }
      const result = await verifyOAuth(token.access_token);
      if (!result.valid || !result.user) {
        return redirect(`${config.webBaseUrl}/?error=${result.code === "ACCOUNT_BANNED" ? "banned" : "denied"}`);
      }

      const user = await upsertUser(result.user);
      const session = await signSession({
        sub: user.id,
        accountsId: user.accountsId,
        username: user.username,
        isAdmin: user.isAdmin,
      });

      // The api and the web app are on different registrable domains (api-social.ado.ink vs
      // social.serika.dev), so a cookie the api sets here would never reach the web app. Hand
      // the session off via a one-time code the web app claims and turns into its OWN cookie,
      // on its own origin. The session JWT never travels in a URL.
      const handoff = base64url(randomBytes(24));
      await redis.set(`webhandoff:${handoff}`, session, "EX", 120);
      return redirect(`${config.webBaseUrl}/auth/finish?code=${handoff}`);
    },
    { query: t.Object({ code: t.String(), state: t.String() }) },
  )

  // The web app claims the one-time handoff code and receives the session token, which it
  // then stores as a cookie on its own origin. Single-use: the code is deleted on claim.
  .get(
    "/claim",
    async ({ query, set }) => {
      const session = await redis.get(`webhandoff:${query.code}`);
      if (!session) {
        set.status = 400;
        return { error: "invalid_or_expired_code" };
      }
      await redis.del(`webhandoff:${query.code}`);
      return { session, maxAge: config.sessionTtlSeconds };
    },
    { query: t.Object({ code: t.String() }) },
  );
