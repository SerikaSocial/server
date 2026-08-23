import { Elysia, t } from "elysia";
import { prisma, redis } from "../db.ts";
import { authed } from "../auth-plugin.ts";
import { signTicket } from "../tokens.ts";
import { place } from "../allocator.ts";

export const instanceRoutes = new Elysia({ prefix: "/v1/instances" })
  .use(authed)

  // Create a fresh instance of a world and return a join ticket for it.
  .post(
    "/",
    async ({ body, session, set }) => {
      const world = await prisma.world.findUnique({ where: { id: body.worldId } });
      if (!world) {
        set.status = 404;
        return { error: "world_not_found" };
      }

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
        access: t.Optional(t.Number()),
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
      const world = await prisma.world.findUnique({ where: { id: body.worldId } });
      if (!world) {
        set.status = 404;
        return { error: "world_not_found" };
      }

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
    const instance = await prisma.instance.findUnique({ where: { id: params.id } });
    if (!instance || instance.closedAt) {
      set.status = 404;
      return { error: "instance_not_found" };
    }

    const count = await redis.hlen(`inst:${instance.id}:roster`);
    if (count >= instance.capacity) {
      set.status = 409;
      return { error: "instance_full" };
    }

    const ticket = await mintTicket(instance.id, session.sub);
    if (!ticket) {
      set.status = 500;
      return { error: "ticket_failed" };
    }
    return { instance: serializeInstance(instance), endpoint: instance.endpoint, ...ticket };
  })

  .get("/:id", async ({ params, set }) => {
    const instance = await prisma.instance.findUnique({ where: { id: params.id } });
    if (!instance || instance.closedAt) {
      set.status = 404;
      return { error: "instance_not_found" };
    }
    const roster = await redis.hkeys(`inst:${instance.id}:roster`);
    return { ...serializeInstance(instance), members: roster };
  });

/// Mint a single-use join ticket and record its jti so the relay can reject replays. The
/// relay marks it used via the gateway; we only need to pre-register the id with a TTL.
async function mintTicket(instanceId: string, userId: string) {
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
  return { ticket: token, jti };
}

function serializeInstance(i: {
  id: string; worldId: string; access: number; mode: number; region: string;
  capacity: number; playerCount: number;
}) {
  return {
    id: i.id,
    worldId: i.worldId,
    access: i.access,
    mode: i.mode,
    region: i.region,
    capacity: i.capacity,
    playerCount: i.playerCount,
  };
}
