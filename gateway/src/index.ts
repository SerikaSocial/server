// Serika Social gateway. A control-plane WebSocket separate from the realtime relay: it
// carries presence, friend online-status, invites, and the `instance.migrate` push. It
// holds no game state — everything durable is in Redis/Postgres — so it scales as stateless
// replicas behind a sticky load balancer.

import { Elysia, t } from "elysia";
import { Redis } from "ioredis";
import { jwtVerify } from "jose";

const PORT = Number(process.env.GATEWAY_PORT ?? 4110);
const SESSION_SECRET = new TextEncoder().encode(
  process.env.SESSION_JWT_SECRET ?? (() => { throw new Error("SESSION_JWT_SECRET required"); })(),
);
const REDIS_URL = process.env.REDIS_URL ?? (() => { throw new Error("REDIS_URL required"); })();

// One command connection for writes, one pub/sub subscriber for pushes. The subscriber
// can't run normal commands, hence the split.
const redis = new Redis(REDIS_URL);
const sub = new Redis(REDIS_URL);

interface Claims { sub: string; username: string }

// userId -> set of live sockets (a user may be in the web app and the game at once).
const sockets = new Map<string, Set<any>>();

async function verify(token: string): Promise<Claims | null> {
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET, { issuer: "serika-social" });
    return { sub: payload.sub as string, username: payload.username as string };
  } catch {
    return null;
  }
}

// Fan pushes out to the right user's sockets. Channel is `gwpush:{userId}`; the message is
// forwarded verbatim (the api/allocator publishes JSON like {type:"invite"|"instance.migrate"}).
sub.psubscribe("gwpush:*");
sub.on("pmessage", (_pattern, channel, message) => {
  const userId = channel.slice("gwpush:".length);
  const conns = sockets.get(userId);
  if (!conns) return;
  for (const ws of conns) ws.send(message);
});

const app = new Elysia()
  .get("/health", () => ({ status: "ok", service: "serika-social-gateway", online: sockets.size }))
  .ws("/gateway", {
    query: t.Object({ token: t.String() }),
    async open(ws) {
      const claims = await verify(ws.data.query.token);
      if (!claims) {
        ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
        ws.close();
        return;
      }
      (ws.data as any).userId = claims.sub;

      let set = sockets.get(claims.sub);
      if (!set) { set = new Set(); sockets.set(claims.sub, set); }
      set.add(ws);

      await redis.sadd("online:users", claims.sub);
      ws.send(JSON.stringify({ type: "ready", userId: claims.sub, username: claims.username }));
    },

    async message(ws, raw) {
      const userId = (ws.data as any).userId as string | undefined;
      if (!userId) return;
      let msg: any;
      try { msg = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }

      switch (msg?.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "presence:friends": {
          // Which of my friends are online right now.
          const friends: string[] = Array.isArray(msg.friends) ? msg.friends : [];
          if (friends.length === 0) { ws.send(JSON.stringify({ type: "presence", online: [] })); break; }
          const flags = await redis.smismember("online:users", ...friends);
          const online = friends.filter((_, i) => flags[i] === 1);
          ws.send(JSON.stringify({ type: "presence", online }));
          break;
        }
      }
    },

    async close(ws) {
      const userId = (ws.data as any).userId as string | undefined;
      if (!userId) return;
      const set = sockets.get(userId);
      set?.delete(ws);
      // Only mark offline once the user's LAST socket goes away.
      if (set && set.size === 0) {
        sockets.delete(userId);
        await redis.srem("online:users", userId);
      }
    },
  })
  .listen(PORT);

console.log(`serika-social-gateway on :${PORT} (ws /gateway)`);

export type Gateway = typeof app;
