import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

// Run with api/test/run-social-integration.sh. All fixtures live in its disposable DB.
const enabled = process.env.SERIKA_SOCIAL_INTEGRATION === "1";
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const owner = id(1), friend = id(2), stranger = id(3), another = id(4), middle = id(5);
const worldId = id(10), fallbackId = id(11), draftId = id(12);
let prisma: typeof import("../src/db.ts").prisma;
let redis: typeof import("../src/db.ts").redis;
let app: Elysia<any, any, any, any, any, any, any>;
const tokens = new Map<string, string>();
let privateId = "", publicId = "";

async function request(method: string, path: string, user: string | null = owner, body?: unknown) {
  const response = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: { ...(user ? { Authorization: `Bearer ${tokens.get(user)}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const raw = await response.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = { error: raw }; }
  return { status: response.status, headers: response.headers, body: parsed };
}

const readyWorld = (worldId: string, name: string, extra = {}) => ({
  id: worldId, name, authorId: owner, releaseStatus: 2, publishedVersionId: id(Number(worldId.slice(-2)) + 100),
  versions: { create: { id: id(Number(worldId.slice(-2)) + 100), version: 1, buildStatus: 2, reviewStatus: 2,
    assets: { create: { platform: 1, bytes: 12n, blake3: Buffer.alloc(32), cdnKey: `${name}.serikaworld` } } } }, ...extra,
});

describe.skipIf(!enabled)("personal Home and private instances through real authenticated HTTP routes", () => {
  beforeAll(async () => {
    const dbUrl = new URL(process.env.DATABASE_URL!);
    if (dbUrl.hostname !== "127.0.0.1" || dbUrl.port !== "55492" || dbUrl.pathname !== "/serika_ui184_test"
      || process.env.REDIS_URL !== "redis://127.0.0.1:65492/0") throw new Error("Refusing a non-disposable datastore");
    ({ prisma, redis } = await import("../src/db.ts"));
    const { signSession } = await import("../src/tokens.ts");
    await prisma.notification.deleteMany(); await prisma.instance.deleteMany(); await prisma.world.deleteMany(); await prisma.user.deleteMany();
    await redis.flushdb();
    for (const [user, username] of [[owner, "host"], [friend, "friend"], [stranger, "stranger"], [another, "another"], [middle, "middle"]]) {
      await prisma.user.create({ data: { id: user!, accountsId: user!, username: username! } });
      tokens.set(user!, await signSession({ sub: user!, accountsId: user!, username: username!, isAdmin: false }));
    }
    for (const [a, b] of [[owner, friend], [friend, stranger], [owner, middle]]) {
      const [userAId, userBId] = [a!, b!].sort();
      await prisma.friend.create({ data: { userAId: userAId!, userBId: userBId!, requestedById: a!, status: 1 } });
    }
    await prisma.world.create({ data: readyWorld(worldId, "Selected") });
    await prisma.world.create({ data: readyWorld(fallbackId, "Default", { isDefaultHome: true }) });
    await prisma.world.create({ data: { id: draftId, name: "Draft", authorId: owner, releaseStatus: 0 } });
    await redis.sadd("nodes", "test-relay");
    await redis.hset("node:test-relay", "endpoint", "relay.example:4200", "load", "0");
    const { homeRoutes } = await import("../src/routes/home.ts");
    const { instanceRoutes } = await import("../src/routes/instances.ts");
    const { worldRoutes } = await import("../src/routes/worlds.ts");
    const { friendRoutes } = await import("../src/routes/social.ts");
    app = new Elysia().use(homeRoutes).use(instanceRoutes).use(worldRoutes).use(friendRoutes)
      .onError(({ set, error }) => ({ error: error instanceof Error ? error.message : String(error) }));
  });
  afterAll(async () => { if (prisma) await prisma.$disconnect(); if (redis) await redis.quit(); });

  test("Home requires a real session on read, write, and reset", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) expect((await request(method, "/v1/users/me/home", null, method === "PUT" ? { worldId } : undefined)).status).toBe(401);
  });
  test("new account resolves platform default and response cannot be cached publicly", async () => {
    const r = await request("GET", "/v1/users/me/home");
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ world: { id: fallbackId }, homeWorldId: null, usingDefault: true });
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  test("Set as Home persists only on the signed-in account", async () => {
    const r = await request("PUT", "/v1/users/me/home", owner, { worldId });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ world: { id: worldId }, homeWorldId: worldId, usingDefault: false });
    expect((await request("GET", "/v1/users/me/home", friend)).body.world.id).toBe(fallbackId);
    expect((await prisma.user.findUnique({ where: { id: owner } }))?.homeWorldId).toBe(worldId);
  });
  test("withdrawn personal Home falls back without serving the withdrawn asset", async () => {
    await prisma.world.update({ where: { id: worldId }, data: { releaseStatus: 0 } });
    expect((await request("GET", "/v1/users/me/home")).body).toMatchObject({ world: { id: fallbackId }, usingDefault: true });
    expect((await request("PUT", "/v1/users/me/home", owner, { worldId })).status).toBe(422);
    await prisma.world.update({ where: { id: worldId }, data: { releaseStatus: 2 } });
  });
  test("draft, rejected, missing assets and missing worlds cannot become Home", async () => {
    expect((await request("PUT", "/v1/users/me/home", owner, { worldId: draftId })).status).toBe(422);
    expect((await request("PUT", "/v1/users/me/home", owner, { worldId: id(99) })).status).toBe(422);
    await prisma.worldVersion.update({ where: { id: id(110) }, data: { reviewStatus: 6 } });
    expect((await request("PUT", "/v1/users/me/home", owner, { worldId })).status).toBe(422);
    await prisma.worldVersion.update({ where: { id: id(110) }, data: { reviewStatus: 2 } });
    await prisma.worldAsset.update({ where: { versionId_platform: { versionId: id(110), platform: 1 } }, data: { cdnKey: "" } });
    expect((await request("PUT", "/v1/users/me/home", owner, { worldId })).status).toBe(422);
    await prisma.worldAsset.update({ where: { versionId_platform: { versionId: id(110), platform: 1 } }, data: { cdnKey: "Selected.serikaworld" } });
  });
  test("reset restores platform default and clears only own selection", async () => {
    expect((await request("DELETE", "/v1/users/me/home")).body).toMatchObject({ world: { id: fallbackId }, homeWorldId: null, usingDefault: true });
  });
  test("create private returns owner and authorized ticket", async () => {
    const r = await request("POST", "/v1/instances/", owner, { worldId, access: 4 });
    expect(r.status).toBe(200); expect(r.body.instance).toMatchObject({ ownerId: owner, access: 4 }); expect(r.body.ticket).toBeString();
    privateId = r.body.instance.id;
  });
  test("private instance UUID cannot disclose members or mint stranger/friend tickets", async () => {
    for (const user of [friend, stranger]) {
      expect((await request("GET", `/v1/instances/${privateId}`, user)).status).toBe(404);
      expect((await request("POST", `/v1/instances/${privateId}/join`, user)).status).toBe(403);
    }
    expect((await request("POST", `/v1/instances/${privateId}/join`)).status).toBe(200);
  });
  test("public browser and matchmaking never enumerate or reuse private instances", async () => {
    const r = await request("GET", `/v1/worlds/${worldId}`, null);
    expect(r.status).toBe(200); expect(r.body.instances).toEqual([]);
    const joined = await request("POST", "/v1/instances/join-world", stranger, { worldId });
    expect(joined.status).toBe(200); expect(joined.body.instance.access).toBe(0); expect(joined.body.instance.id).not.toBe(privateId);
    publicId = joined.body.instance.id;
  });
  test("live gateway rejects a guessed private room and accepts an API-admitted owner", async () => {
    const gateway = Bun.spawn([process.execPath, "gateway/src/index.ts"], {
      env: { ...process.env, GATEWAY_PORT: "41192" }, stdout: "ignore", stderr: "pipe",
    });
    const sockets: WebSocket[] = [];
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        try { ready = (await fetch("http://127.0.0.1:41192/health")).ok; } catch {}
        if (ready) break;
        await Bun.sleep(20);
      }
      expect(ready).toBe(true);
      async function connect(userId: string) {
        const socket = new WebSocket(`ws://127.0.0.1:41192/gateway?token=${tokens.get(userId)}`);
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error("Gateway ready timeout")), 2000);
          socket.addEventListener("message", (event) => { if (JSON.parse(String(event.data)).type === "ready") { clearTimeout(timeout); resolve(); } });
        });
        return socket;
      }
      async function send(socket: WebSocket, message: unknown) {
        return new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error("Gateway response timeout")), 2000);
          socket.addEventListener("message", (event) => { clearTimeout(timeout); resolve(JSON.parse(String(event.data))); }, { once: true });
          socket.send(JSON.stringify(message));
        });
      }
      const denied = await connect(stranger);
      expect(await send(denied, { type: "rtc:join", instanceId: privateId })).toMatchObject({ type: "error", error: "instance_not_authorized" });
      const allowed = await connect(owner);
      expect(await send(allowed, { type: "rtc:join", instanceId: privateId })).toMatchObject({ type: "rtc:peers", instanceId: privateId, peers: [] });
      denied.send(JSON.stringify({ type: "instance:migrate", instanceId: privateId }));
      await send(denied, { type: "ping" });
      expect(await redis.exists(`presence:${stranger}`)).toBe(0);
    } finally {
      for (const socket of sockets) socket.close();
      gateway.kill(); await gateway.exited;
    }
  });
  test("private owner invitation grants its exact recipient access durably", async () => {
    const r = await request("POST", "/v1/social/invite", owner, { targetUserId: friend, instanceId: privateId });
    expect(r.status).toBe(200); expect(r.body.status).toBe("sent");
    const row = await prisma.notification.findUnique({ where: { id: r.body.notificationId } });
    expect(row?.data).toMatchObject({ instanceId: privateId, access: 4 });
    expect((await request("POST", `/v1/instances/${privateId}/join`, friend)).status).toBe(200);
    expect((await request("POST", `/v1/instances/${privateId}/join`, stranger)).status).toBe(403);
  });
  test("a private invitee cannot invite another friend or forward access", async () => {
    await redis.hset(`inst:${privateId}:roster`, friend, "{}");
    expect((await request("POST", "/v1/social/invite", friend, { targetUserId: stranger, instanceId: privateId })).status).toBe(403);
    await redis.hdel(`inst:${privateId}:roster`, friend);
  });
  test("expired invitations no longer authorize a new private join", async () => {
    await prisma.notification.updateMany({ where: { userId: friend, kind: "invite" }, data: { expiresAt: new Date(0) } });
    expect((await request("POST", `/v1/instances/${privateId}/join`, friend)).status).toBe(403);
  });
  test("blocked recipients cannot reuse invitations", async () => {
    await request("POST", "/v1/social/invite", owner, { targetUserId: friend, instanceId: privateId });
    await prisma.block.create({ data: { userId: friend, blockedId: owner } });
    expect((await request("POST", `/v1/instances/${privateId}/join`, friend)).status).toBe(403);
    await prisma.block.deleteMany();
  });
  test("non-occupants cannot issue invitations to guessed public rooms", async () => {
    expect((await request("POST", "/v1/social/invite", owner, { targetUserId: friend, instanceId: publicId })).status).toBe(403);
  });
  test("unpublished author tests must be explicitly private and stay inaccessible to friends", async () => {
    expect((await request("POST", "/v1/instances/join-world", owner, { worldId: draftId })).status).toBe(403);
    expect((await request("POST", "/v1/instances/", owner, { worldId: draftId, access: 0 })).status).toBe(403);
    const r = await request("POST", "/v1/instances/", owner, { worldId: draftId, access: 4 });
    expect(r.status).toBe(200);
    expect((await request("POST", "/v1/social/invite", owner, { targetUserId: friend, instanceId: r.body.instance.id })).status).toBe(403);
  });
  test("legacy friends and friends-of-friends modes enforce their social boundaries", async () => {
    const f = await request("POST", "/v1/instances/", owner, { worldId, access: 1 });
    expect((await request("POST", `/v1/instances/${f.body.instance.id}/join`, friend)).status).toBe(200);
    expect((await request("POST", `/v1/instances/${f.body.instance.id}/join`, stranger)).status).toBe(403);
    const fof = await request("POST", "/v1/instances/", owner, { worldId, access: 2 });
    expect((await request("POST", `/v1/instances/${fof.body.instance.id}/join`, stranger)).status).toBe(200);
    expect((await request("POST", `/v1/instances/${fof.body.instance.id}/join`, another)).status).toBe(403);
  });
  test("new instances and active join tickets survive sweeping until grace expires", async () => {
    const { sweepStaleInstances } = await import("../src/routes/instances.ts");
    await sweepStaleInstances();
    expect((await prisma.instance.findUnique({ where: { id: privateId } }))?.closedAt).toBeNull();
    await prisma.instance.update({ where: { id: privateId }, data: { createdAt: new Date(Date.now() - 120_000) } });
    await sweepStaleInstances();
    expect((await prisma.instance.findUnique({ where: { id: privateId } }))?.closedAt).toBeNull();
    await redis.del(`instance:connecting:${privateId}`); await sweepStaleInstances();
    expect((await prisma.instance.findUnique({ where: { id: privateId } }))?.closedAt).not.toBeNull();
    expect((await request("POST", `/v1/instances/${privateId}/join`)).status).toBe(404);
  });
  test("invalid access enum values are rejected", async () => {
    for (const access of [-1, 5, 2.5]) expect((await request("POST", "/v1/instances/", owner, { worldId, access })).status).toBeGreaterThanOrEqual(400);
  });
});
