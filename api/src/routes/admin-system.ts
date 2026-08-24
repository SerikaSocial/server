import { Elysia, t } from "elysia";
import { redis, keys } from "../db.ts";
import { adminOnly } from "../auth-plugin.ts";

/// Admin system controls: maintenance mode and emergency instance shutdown.
///
/// Maintenance mode sets a Redis flag that:
///   1. The API checks on every join endpoint — rejects with 503 "maintenance".
///   2. The relay checks in its sweep loop — kicks all connected peers.
///
/// "Kill instances" clears all live rosters and presence from Redis, which causes
/// the relay to time out peers within one sweep cycle (1 s) and removes them from
/// the allocator's node registry.
export const adminSystemRoutes = new Elysia({ prefix: "/v1/admin/system" })
  .use(adminOnly)

  // ── Maintenance mode ──────────────────────────────────────────────────────
  .get("/maintenance", async () => {
    const flag = await redis.get(keys.maintenance);
    return { enabled: flag === "1" };
  })

  .post(
    "/maintenance",
    async ({ body }) => {
      if (body.enabled) {
        await redis.set(keys.maintenance, "1");
      } else {
        await redis.del(keys.maintenance);
      }
      return { ok: true, enabled: body.enabled };
    },
    { body: t.Object({ enabled: t.Boolean() }) },
  )

  // ── Kill all instances ────────────────────────────────────────────────────
  // Clears every roster hash and presence key so the relay times out all peers
  // and the allocator sees zero load. Also clears the node registry so no new
  // traffic is routed until relays re-heartbeat.
  .post("/kill-instances", async () => {
    let rosters = 0;
    let presence = 0;

    // Scan and delete all inst:*:roster keys
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", "inst:*:roster", "COUNT", 100);
      cursor = next;
      for (const key of batch) {
        await redis.del(key);
        rosters++;
      }
    } while (cursor !== "0");

    // Scan and delete all presence:* keys
    cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 100);
      cursor = next;
      for (const key of batch) {
        await redis.del(key);
        presence++;
      }
    } while (cursor !== "0");

    // Clear node registry so allocator stops routing to relays momentarily
    const nodeIds = await redis.smembers("nodes");
    for (const id of nodeIds) {
      await redis.del(`node:${id}`);
    }
    await redis.del("nodes");

    // Clear online users set
    await redis.del(keys.onlineUsers);

    return { ok: true, rostersCleared: rosters, presenceCleared: presence };
  });
