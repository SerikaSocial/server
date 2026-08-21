import { Elysia, t } from "elysia";
import { prisma } from "../db.ts";

export const worldRoutes = new Elysia({ prefix: "/v1/worlds" })
  // Public browse. Ordered by heat; only community/public worlds plus built-ins.
  .get(
    "/",
    async ({ query }) => {
      const take = Math.min(Number(query.limit ?? 50), 100);
      const worlds = await prisma.world.findMany({
        where: { OR: [{ releaseStatus: { gte: 1 } }, { isBuiltin: true }] },
        orderBy: [{ heat: "desc" }, { visitCount: "desc" }],
        take,
      });
      return worlds.map(serializeWorld);
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  .get("/:id", async ({ params, set }) => {
    const world = await prisma.world.findUnique({ where: { id: params.id } });
    if (!world) {
      set.status = 404;
      return { error: "not_found" };
    }
    // Live instance list for this world, straight from the durable table (open instances).
    const instances = await prisma.instance.findMany({
      where: { worldId: world.id, closedAt: null },
      orderBy: { createdAt: "asc" },
    });
    return {
      ...serializeWorld(world),
      instances: instances.map((i) => ({
        id: i.id,
        access: i.access,
        mode: i.mode,
        region: i.region,
        playerCount: i.playerCount,
        capacity: i.capacity,
      })),
    };
  });

function serializeWorld(w: {
  id: string; name: string; description: string; tags: string[];
  capacity: number; releaseStatus: number; isBuiltin: boolean; visitCount: bigint; heat: number;
}) {
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    tags: w.tags,
    capacity: w.capacity,
    releaseStatus: w.releaseStatus,
    isBuiltin: w.isBuiltin,
    visitCount: Number(w.visitCount),
    heat: w.heat,
  };
}
