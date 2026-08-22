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

// WebRTC signalling rooms for P2P instances: instanceId -> set of member userIds. The gateway is
// only the signalling channel (offer/answer/ICE candidate exchange); once peers connect, game
// traffic flows directly over their data channels, never through here.
const rtcRooms = new Map<string, Set<string>>();

// Send a JSON object to every live socket of a user.
function sendToUser(userId: string, obj: unknown): void {
  const conns = sockets.get(userId);
  if (!conns) return;
  const s = JSON.stringify(obj);
  for (const ws of conns) ws.send(s);
}

// Remove a user from a signalling room and tell the remaining peers.
function rtcLeave(instanceId: string, userId: string): void {
  const room = rtcRooms.get(instanceId);
  if (!room || !room.has(userId)) return;
  room.delete(userId);
  for (const other of room) sendToUser(other, { type: "rtc:peer-leave", instanceId, peer: userId });
  if (room.size === 0) rtcRooms.delete(instanceId);
}

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
  .post("/internal/push", async ({ body }) => {
    const { userId, message } = body as { userId: string; message: string };
    const conns = sockets.get(userId);
    if (!conns) return { delivered: false, reason: "offline" };
    let sent = 0;
    for (const ws of conns) { ws.send(message); sent++; }
    return { delivered: true, sent };
  }, {
    body: t.Object({ userId: t.String(), message: t.String() }),
  })
  .post("/internal/invite", async ({ body }) => {
    const { targetUserId, fromUserId, fromUsername, worldId, worldName } = body as {
      targetUserId: string; fromUserId: string; fromUsername: string; worldId: string; worldName: string;
    };
    const conns = sockets.get(targetUserId);
    if (!conns) return { delivered: false, reason: "offline" };
    const msg = JSON.stringify({
      type: "invite",
      from: { userId: fromUserId, username: fromUsername },
      world: { id: worldId, name: worldName },
      timestamp: Date.now(),
    });
    let sent = 0;
    for (const ws of conns) { ws.send(msg); sent++; }
    return { delivered: true, sent };
  }, {
    body: t.Object({
      targetUserId: t.String(),
      fromUserId: t.String(),
      fromUsername: t.String(),
      worldId: t.String(),
      worldName: t.String(),
    }),
  })
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
        case "invite:respond": {
          // Client accepts or declines an invite. Publish to the sender's push channel.
          const { inviteId, accept, fromUserId } = msg;
          if (fromUserId) {
            const reply = JSON.stringify({
              type: "invite:response",
              inviteId,
              accept: !!accept,
              by: userId,
            });
            await redis.publish(`gwpush:${fromUserId}`, reply);
          }
          break;
        }
        case "instance:migrate": {
          // Client acknowledges a migration. Update presence.
          if (msg.instanceId) {
            await redis.hset(`presence:${userId}`, "instanceId", msg.instanceId);
          }
          break;
        }

        // ── WebRTC signalling (P2P instances) ─────────────────────────────────────────
        case "rtc:join": {
          // Enter an instance's signalling room. The reply lists existing peers so the joiner
          // knows whom to send offers to (initiator = the newcomer, to keep offers one-directional).
          const instanceId: string = msg.instanceId;
          if (!instanceId) break;
          let room = rtcRooms.get(instanceId);
          if (!room) { room = new Set(); rtcRooms.set(instanceId, room); }
          const existing = [...room].filter((u) => u !== userId);
          room.add(userId);
          ws.send(JSON.stringify({ type: "rtc:peers", instanceId, peers: existing }));
          for (const other of existing) sendToUser(other, { type: "rtc:peer-join", instanceId, peer: userId });
          break;
        }
        case "rtc:signal": {
          // Relay an SDP offer/answer or ICE candidate to a specific peer in the room.
          const { instanceId, to, data } = msg;
          const room = rtcRooms.get(instanceId);
          if (!instanceId || !to || !room || !room.has(userId) || !room.has(to)) break;
          sendToUser(to, { type: "rtc:signal", instanceId, from: userId, data });
          break;
        }
        case "rtc:leave": {
          if (msg.instanceId) rtcLeave(msg.instanceId, userId);
          break;
        }
      }
    },

    async close(ws) {
      const userId = (ws.data as any).userId as string | undefined;
      if (!userId) return;
      const set = sockets.get(userId);
      set?.delete(ws);
      // Only mark offline (and drop from signalling rooms) once the user's LAST socket goes away.
      if (set && set.size === 0) {
        sockets.delete(userId);
        await redis.srem("online:users", userId);
        for (const instanceId of [...rtcRooms.keys()]) rtcLeave(instanceId, userId);
      }
    },
  })
  .listen(PORT);

console.log(`serika-social-gateway on :${PORT} (ws /gateway)`);

export type Gateway = typeof app;
