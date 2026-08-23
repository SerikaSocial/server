import { Elysia, t } from "elysia";
import { prisma, redis } from "../db.ts";
import { assetPublicUrl } from "../storage.ts";
import { sweepStaleInstances } from "./instances.ts";

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
        include: {
          author: { select: { username: true } },
          versions: { where: { buildStatus: 2 }, orderBy: { version: "desc" }, take: 1, include: { assets: true } },
        },
      });
      return worlds.map((w) => serializeWorld(w));
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  .get("/:id", async ({ params, set }) => {
    const world = await prisma.world.findUnique({
      where: { id: params.id },
      include: {
        author: { select: { username: true } },
        versions: { where: { buildStatus: 2 }, orderBy: { version: "desc" }, take: 1, include: { assets: true } },
      },
    });
    if (!world) {
      set.status = 404;
      return { error: "not_found" };
    }
    // Opportunistically close empty instances before listing.
    await sweepStaleInstances(world.id);

    // Live instance list for this world, straight from the durable table (open instances).
    const instances = await prisma.instance.findMany({
      where: { worldId: world.id, closedAt: null },
      orderBy: { createdAt: "asc" },
    });

    // Fetch live player counts from Redis rosters in parallel.
    const liveCounts = await Promise.all(
      instances.map((i) => redis.hlen(`inst:${i.id}:roster`)),
    );

    return {
      ...serializeWorld(world),
      instances: instances.map((i, idx) => ({
        id: i.id,
        access: i.access,
        mode: i.mode,
        region: i.region,
        playerCount: liveCounts[idx] ?? 0,
        capacity: i.capacity,
      })),
    };
  });

function serializeWorld(w: any) {
  const latestVersion = w.versions?.[0];
  const platformAsset = latestVersion?.assets?.find((a: any) =>
    a.platform === (process.platform === "win32" ? 0 : process.platform === "linux" ? 1 : 2)
  ) ?? latestVersion?.assets?.[0];
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
    author: w.author?.username ?? null,
    downloadUrl: platformAsset?.cdnKey ? assetPublicUrl(platformAsset.cdnKey) : null,
    thumbnailUrl: null,
  };
}
