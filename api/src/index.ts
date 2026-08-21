import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { config } from "./config.ts";
import { prisma, redis } from "./db.ts";
import { sessionRoutes } from "./routes/session.ts";
import { webAuthRoutes } from "./routes/web-auth.ts";
import { worldRoutes } from "./routes/worlds.ts";
import { instanceRoutes } from "./routes/instances.ts";
import { assetRoutes } from "./routes/assets.ts";

const app = new Elysia()
  .use(cors())
  // Health check doubles as a liveness probe for Coolify and a datastore smoke test.
  .get("/health", async () => {
    const [dbOk, redisOk] = await Promise.all([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      redis.ping().then((r) => r === "PONG").catch(() => false),
    ]);
    return { status: dbOk && redisOk ? "ok" : "degraded", service: "serika-social-api", db: dbOk, redis: redisOk };
  })
  .use(sessionRoutes)
  .use(webAuthRoutes)
  .use(worldRoutes)
  .use(instanceRoutes)
  .use(assetRoutes)
  .onError(({ code, error, set }) => {
    // Elysia surfaces our thrown auth errors here; keep 401s as 401s, everything else 500.
    if (set.status === 401) return { error: String(error instanceof Error ? error.message : error) };
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "validation", detail: String(error instanceof Error ? error.message : error) };
    }
    console.error("[api]", code, error);
    set.status = set.status && set.status !== 200 ? set.status : 500;
    return { error: "internal_error" };
  })
  .listen(config.port);

console.log(`serika-social-api on :${config.port} → db ${config.databaseUrl.replace(/:[^:@]*@/, ":****@")}`);

export type App = typeof app;
