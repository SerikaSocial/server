import { Elysia, t } from "elysia";
import { prisma, redis, keys } from "../db.ts";
import { authed } from "../auth-plugin.ts";
import { signTicket } from "../tokens.ts";
import { place } from "../allocator.ts";
import { canAccessInstance, worldJoinGate, InstanceAccess } from "../instance-access.ts";
import { recordWorldVisit } from "./hub.ts";

/// Check maintenance mode — returns true if the flag is set in Redis. Admins bypass it.
export async function isMaintenance(userId: string): Promise<boolean> {
  const flag = await redis.get(keys.maintenance);
  if (flag !== "1") return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
  return !user?.isAdmin;
}

/// Close instances whose Redis roster is empty and have been idle for a grace period.
/// Called opportunistically from the world detail endpoint and from the periodic sweep.
///
/// Instances belonging to an OPEN OR LIVE event are exempt, and that exemption is the whole
/// reason this function takes an event into account at all. An event venue is heavy: the first
/// visit on a machine compiles the show's shaders and can freeze the client for minutes, long
/// past the relay's 10 s PEER_TIMEOUT, so the roster legitimately empties out while everyone is
/// still loading. Sweeping the instance then means the next `/v1/events/:id/join` finds nothing
/// open and allocates a fresh one — which is exactly how an event ends up with every attendee
/// alone in their own instance. An event's instances are closed explicitly by `event.close`.
export async function sweepStaleInstances(worldId?: string) {
  const where = { closedAt: null, createdAt: { lt: new Date(Date.now() - 90_000) }, ...(worldId ? { worldId } : {}) };
  const open = await prisma.instance.findMany({ where, select: { id: true, createdAt: true, eventId: true, event: { select: { status: true } } } });
  if (open.length === 0) return;

  const counts = await Promise.all(
    open.map((i) => redis.hlen(`inst:${i.id}:roster`)),
  );

  const connecting = await Promise.all(open.map((i) => redis.exists(`instance:connecting:${i.id}`)));
  const stale = open.filter((inst, i) =>
    counts[i] === 0 && connecting[i] === 0 && !(inst.event && ["open", "live"].includes(inst.event.status)));
  if (stale.length === 0) return;

  await prisma.instance.updateMany({
    where: { id: { in: stale.map((s) => s.id) } },
    data: { closedAt: new Date() },
  });
}

/// Periodic sweep — close ALL stale instances across all worlds.
let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startInstanceSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepStaleInstances().catch((e) => console.error("[sweep]", e));
  }, 60_000); // every minute
}

export const instanceRoutes = new Elysia({ prefix: "/v1/instances" })
  .use(authed)
  .onBeforeHandle(({ set }) => { set.headers["Cache-Control"] = "private, no-store"; })

  // Create a fresh instance of a world and return a join ticket for it.
  .post(
    "/",
    async ({ body, session, set }) => {
      if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
      const world = await prisma.world.findUnique({ where: { id: body.worldId } });
      if (!world) {
        set.status = 404;
        return { error: "world_not_found" };
      }
      const gate = await worldJoinGate(world, session.sub, body.access === InstanceAccess.Private);
      if (gate) { set.status = 403; return { error: gate }; }
      if (await isMaintenance(session.sub)) { set.status = 503; return { error: "maintenance" }; }

      const placement = await place({
        capacity: world.capacity,
        forceDedicated: world.forceDedicated,
      });
      if (!placement) {
        set.status = 503;
        return { error: "no_relay_available" };
      }

      const instance = await prisma.instance.create({
        data: {
          worldId: world.id,
          worldVersionId: world.publishedVersionId,
          ownerId: session.sub,
          access: body.access ?? 0,
          mode: placement.mode,
          nodeId: placement.nodeId,
          endpoint: placement.endpoint,
          capacity: world.capacity,
        },
      });

      const ticket = await mintTicket(instance.id, session.sub);
      if (!ticket) {
        set.status = 500;
        return { error: "ticket_failed" };
      }
      // The Hub renders recent worlds from this — recorded here so the client
      // never reports its own history.
      void recordWorldVisit(session.sub, world.id);

      return {
        instance: serializeInstance(instance),
        endpoint: instance.endpoint,
        worldName: world.name,
        ...ticket,
      };
    },
    {
      body: t.Object({
        worldId: t.String(),
        access: t.Optional(t.Integer({ minimum: 0, maximum: 4 })),
      }),
    },
  )

  // VRChat-style default matchmaking: join the first open, public, non-full instance of a
  // world — or create one if none exists. This is what "join a world" should do; the plain
  // `POST /` (create) always spins up a *fresh* instance, which is why two players joining
  // the same world never saw each other (each got their own empty instance).
  .post(
    "/join-world",
    async ({ body, session, set }) => {
      if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
      const world = await prisma.world.findUnique({ where: { id: body.worldId } });
      if (!world) {
        set.status = 404;
        return { error: "world_not_found" };
      }
      const gate = await worldJoinGate(world, session.sub);
      if (gate) { set.status = 403; return { error: gate }; }
      if (await isMaintenance(session.sub)) { set.status = 503; return { error: "maintenance" }; }

      // Prefer an existing open public instance with room; oldest first so everyone funnels
      // into the same one rather than scattering across half-empty instances.
      const open = await prisma.instance.findMany({
        where: { worldId: world.id, closedAt: null, access: 0 },
        orderBy: { createdAt: "asc" },
      });
      let chosen: (typeof open)[number] | null = null;
      for (const inst of open) {
        const count = await redis.hlen(`inst:${inst.id}:roster`);
        if (count < inst.capacity) {
          chosen = inst;
          break;
        }
      }

      // None joinable → allocate a fresh one.
      if (!chosen) {
        const placement = await place({
          capacity: world.capacity,
          forceDedicated: world.forceDedicated,
        });
        if (!placement) {
          set.status = 503;
          return { error: "no_relay_available" };
        }
        chosen = await prisma.instance.create({
          data: {
            worldId: world.id,
            worldVersionId: world.publishedVersionId,
            ownerId: session.sub,
            access: 0,
            mode: placement.mode,
            nodeId: placement.nodeId,
            endpoint: placement.endpoint,
            capacity: world.capacity,
          },
        });
      }

      const ticket = await mintTicket(chosen.id, session.sub);
      if (!ticket) {
        set.status = 500;
        return { error: "ticket_failed" };
      }
      void recordWorldVisit(session.sub, world.id);
      return {
        instance: serializeInstance(chosen),
        endpoint: chosen.endpoint,
        worldName: world.name,
        ...ticket,
      };
    },
    { body: t.Object({ worldId: t.String() }) },
  )

  // Join an existing open instance: returns a ticket if there's room.
  .post("/:id/join", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const instance = await prisma.instance.findUnique({ where: { id: params.id } });
    if (!instance || instance.closedAt) {
      set.status = 404;
      return { error: "instance_not_found" };
    }

    if (!await canAccessInstance(instance, session.sub)) {
      set.status = 403; return { error: "instance_private" };
    }
    const world = await prisma.world.findUnique({ where: { id: instance.worldId } });
    const gate = world ? await worldJoinGate(world, session.sub, instance.access === InstanceAccess.Private, !!instance.eventId) : "world_not_found";
    if (gate) { set.status = 403; return { error: gate }; }

    const count = await redis.hlen(`inst:${instance.id}:roster`);
    if (count >= instance.capacity) {
      set.status = 409;
      return { error: "instance_full" };
    }

    if (await isMaintenance(session.sub)) { set.status = 503; return { error: "maintenance" }; }

    const ticket = await mintTicket(instance.id, session.sub);
    if (!ticket) {
      set.status = 500;
      return { error: "ticket_failed" };
    }
    void recordWorldVisit(session.sub, instance.worldId);
    return { instance: serializeInstance(instance), endpoint: instance.endpoint, worldName: world!.name, ...ticket };
  })

  .get("/:id", async ({ params, session, set }) => {
    const instance = await prisma.instance.findUnique({ where: { id: params.id } });
    if (!instance || instance.closedAt) {
      set.status = 404;
      return { error: "instance_not_found" };
    }
    if (!await canAccessInstance(instance, session.sub)) {
      set.status = 404; return { error: "instance_not_found" };
    }
    const roster = await redis.hkeys(`inst:${instance.id}:roster`);
    return { ...serializeInstance(instance), members: roster };
  })

  // Close an instance. Only the owner or an admin can close it. Also cleans up the Redis roster.
  .post(
    "/:id/close",
    async ({ params, session, set }) => {
      if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
      const instance = await prisma.instance.findUnique({ where: { id: params.id } });
      if (!instance || instance.closedAt) {
        set.status = 404;
        return { error: "instance_not_found" };
      }
      const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { isAdmin: true } });
      if (instance.ownerId !== session.sub && !user?.isAdmin) {
        set.status = 403;
        return { error: "not_authorized" };
      }
      await prisma.instance.update({ where: { id: params.id }, data: { closedAt: new Date() } });
      await redis.del(`inst:${params.id}:roster`);
      return { status: "closed" };
    },
    { params: t.Object({ id: t.String() }) },
  );

/// Mint a single-use join ticket and record its jti so the relay can reject replays. The
/// relay marks it used via the gateway; we only need to pre-register the id with a TTL.
export async function mintTicket(instanceId: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const { token, jti } = await signTicket({
    sub: user.id,
    instanceId,
    username: user.username,
    avatarId: user.currentAvatarId,
  });
  // Pre-register the ticket as valid-and-unused; the relay atomically flips it on use.
  await redis.set(`ticket:valid:${jti}`, instanceId, "EX", 60);
  // Gateway signalling requires the same API-authorized admission as the relay. This
  // short grant covers the connect window without exposing a long-lived credential.
  await redis.set(`instance:admission:${instanceId}:${userId}`, "1", "EX", 60);
  await redis.set(`instance:connecting:${instanceId}`, "1", "EX", 90);
  return { ticket: token, jti };
}

export function serializeInstance(i: {
  id: string; worldId: string; access: number; mode: number; region: string;
  capacity: number; playerCount: number; ownerId: string | null;
}) {
  return {
    id: i.id,
    worldId: i.worldId,
    ownerId: i.ownerId,
    access: i.access,
    mode: i.mode,
    region: i.region,
    capacity: i.capacity,
    playerCount: i.playerCount,
  };
}
