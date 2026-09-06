import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { config } from "./config.ts";
import { prisma, redis } from "./db.ts";
import { homeRoutes } from "./routes/home.ts";
import { sessionRoutes } from "./routes/session.ts";
import { webAuthRoutes } from "./routes/web-auth.ts";
import { worldRoutes, worldUploadRoutes } from "./routes/worlds.ts";
import { instanceRoutes } from "./routes/instances.ts";
import { assetRoutes } from "./routes/assets.ts";
import { friendRoutes } from "./routes/social.ts";
import { avatarPublicRoutes, assetFileRoutes, avatarRoutes, adminRoutes } from "./routes/avatars.ts";
import { rtcRoutes } from "./routes/rtc.ts";
import { videoRoutes } from "./routes/video.ts";
import { reviewPublicRoutes, reviewRoutes } from "./routes/reviews.ts";
import { adminReviewRoutes } from "./routes/admin-review.ts";
import { adminSystemRoutes } from "./routes/admin-system.ts";
import { reportRoutes, adminReportRoutes } from "./routes/reports.ts";
import { publicUserRoutes, authedUserRoutes } from "./routes/users.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { startInstanceSweep } from "./routes/instances.ts";

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
  .use(homeRoutes)
  .use(sessionRoutes)
  .use(webAuthRoutes)
  .use(worldRoutes)
  .use(worldUploadRoutes)
  .use(instanceRoutes)
  .use(assetRoutes)
  .use(friendRoutes)
  .use(avatarPublicRoutes)
  .use(assetFileRoutes)
  .use(avatarRoutes)
  .use(adminRoutes)
  .use(adminReviewRoutes)
  .use(adminSystemRoutes)
  .use(reportRoutes)
  .use(adminReportRoutes)
  .use(rtcRoutes)
  .use(videoRoutes)
  .use(reviewPublicRoutes)
  .use(reviewRoutes)
  .use(publicUserRoutes)
  .use(authedUserRoutes)
  .use(notificationRoutes)
  .onError(({ code, error, set }) => {
    // Elysia surfaces our thrown auth errors here; keep 401s as 401s, everything else 500.
    if (set.status === 401 || set.status === 403) return { error: String(error instanceof Error ? error.message : error) };
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

startInstanceSweep();

export type App = typeof app;
