// Bun auto-loads .env from the nearest parent. We read from server/.env, which holds the
// live Coolify database URLs and our own signing secrets.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.API_PORT ?? 4100),
  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL"),

  // Signs our own session JWTs and the join tickets the relay consumes. NOT the
  // serika-accounts secret — a compromise here does not compromise identity.
  sessionSecret: required("SESSION_JWT_SECRET"),
  ticketSecret: required("INSTANCE_TICKET_SECRET"),
  sessionTtlSeconds: 60 * 60 * 12,
  ticketTtlSeconds: 60, // a join ticket is single-use and short-lived by design

  // serika-accounts — the identity provider.
  accounts: {
    baseUrl: process.env.ACCOUNTS_BASE_URL ?? "http://localhost:3600",
    internalKey: required("ACCOUNTS_INTERNAL_KEY"),
    clientId: process.env.OAUTH_CLIENT_ID ?? "serika-social-game",
    redirectUri: process.env.OAUTH_REDIRECT_URI ?? "http://127.0.0.1:34517/callback",
    // Where serika-accounts sends the browser back for the WEB login flow. Must be
    // registered for the serika-social client.
    webCallbackUrl: process.env.WEB_OAUTH_CALLBACK ?? "http://localhost:4100/v1/web/callback",
  },

  webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:3000",
} as const;
