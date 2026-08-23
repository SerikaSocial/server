// Seeds the built-in world and avatar. Idempotent — safe to run repeatedly. Run with:
//   bun src/seed.ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { prisma, redis } from "./db.ts";
import { putBytes } from "./storage.ts";

const SUISEI_AVATAR_ID = "00000000-0000-0000-0000-0000000000a1";
const SUISEI_VERSION_ID = "00000000-0000-0000-0000-00000000a101";

/// Seed the bundled Suisei `.ska` as a curated default outfit. Stores the bytes (S3 or local
/// fallback) and records the avatar + published version. Skips gracefully if the asset is absent.
async function seedSuisei() {
  const skaPath = resolve(import.meta.dir, "../../../game/Assets/Avatars/suisei.ska");
  let bytes: Buffer;
  try {
    bytes = await readFile(skaPath);
  } catch {
    console.warn(`  suisei: ${skaPath} not found — skipping default outfit seed`);
    return;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = `av/${hash.slice(0, 2)}/${hash}.ska`;
  await putBytes(key, bytes, "application/octet-stream");

  await prisma.avatar.upsert({
    where: { id: SUISEI_AVATAR_ID },
    create: {
      id: SUISEI_AVATAR_ID,
      name: "星街すいせい (Hoshimachi Suisei)",
      releaseStatus: 2,
      perfRank: 1,
      sourceFormat: 1, // vrm
      isBuiltin: true,
      isDefaultOutfit: true,
      publishedVersionId: SUISEI_VERSION_ID,
      versions: {
        create: {
          id: SUISEI_VERSION_ID,
          version: 1,
          cdnKey: key,
          blake3: Buffer.from(hash, "hex"),
          stats: { heightMeters: 1.574, eyeHeightMeters: 1.474, boneCount: 54, sizeBytes: bytes.length },
        },
      },
    },
    update: { isDefaultOutfit: true, name: "星街すいせい (Hoshimachi Suisei)" },
  });
  console.log(`  avatar ${SUISEI_AVATAR_ID} — Suisei (default outfit)`);
}

async function main() {
  // Default avatar: every new account is assigned this so nobody is avatar-less.
  const avatar = await prisma.avatar.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000a0" },
    create: {
      id: "00000000-0000-0000-0000-0000000000a0",
      name: "Serika (default)",
      releaseStatus: 2,
      perfRank: 0,
      sourceFormat: 0,
      isBuiltin: true,
    },
    update: { name: "Serika (default)" },
  });

  // Look up pikachubolk to attribute authored worlds to them.
  const pikachubolk = await prisma.user.findFirst({ where: { username: "pikachubolk" } });
  const authorId = pikachubolk?.id ?? null;

  // Default world: the M1 spawn. Ships inside the client, so it needs no CDN asset.
  const world = await prisma.world.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000e0" },
    create: {
      id: "00000000-0000-0000-0000-0000000000e0",
      name: "The Commons",
      description: "The default gathering place. Built into the client.",
      tags: ["hangout", "default"],
      capacity: 32,
      releaseStatus: 2,
      isBuiltin: true,
      isDefaultHome: true, // placeholder default Home until a dedicated home world exists
      heat: 1000, // pin it to the top of the browser
    },
    update: { name: "The Commons", isDefaultHome: true },
  });

  // ── Community worlds by pikachubolk ─────────────────────────────────────────────
  // These are genuine public worlds (not builtin) attributed to pikachubolk.
  // The client renders them by ID via Worlds.BuildWorldForId() — no CDN asset needed.

  const communityWorlds = [
    { id: "00000000-0000-0000-0000-0000000000e1", name: "Mirror Gallery", description: "A room lined with mirrors on every wall. Check your avatar from every angle. Bright even lighting, central pedestal, eight full-length mirrors.", tags: ["mirror", "social"], capacity: 16, heat: 500 },
    { id: "00000000-0000-0000-0000-0000000000e2", name: "Serika Home", description: "The cosy Home house as a multiplayer world. Warm fireplace, couch, coffee table, bookshelf, mirror — all the comforts of home, now with friends.", tags: ["home", "social"], capacity: 8, heat: 400 },
    { id: "00000000-0000-0000-0000-0000000000e3", name: "Cinema", description: "A cinema-style world with a large 12m screen and tiered seating. Dim ambient lighting for that movie theatre vibe. Perfect for watch parties.", tags: ["video", "social", "cinema"], capacity: 32, heat: 300 },
    { id: "00000000-0000-0000-0000-0000000000e4", name: "Test: Empty Room", description: "Minimal test room — floor, four walls, grid lines. The blank canvas for testing movement, collision, and avatar scaling.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e5", name: "Test: Pillar Maze", description: "A grid of collidable pillars for navigation and pathfinding testing. 7×7 grid with 6m spacing.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e6", name: "Test: Ramps", description: "Platforms at different heights connected by ramps. Tests slope collision, gravity, and jumping.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e7", name: "Test: Color Grid", description: "A floor of 100 differently colored tiles arranged in a 10×10 grid. Tests material rendering and color perception.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e8", name: "Test: Sphere Garden", description: "A scattering of 30 decorative spheres in various sizes and colors, plus three large translucent spheres. Tests sphere collision and transparency.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e9", name: "Backrooms", description: "Yellow wallpaper maze with flickering fluorescent lights and damp carpet. Liminal horror atmosphere. Placeholder geometry — full 3D model coming.", tags: ["maze", "horror", "liminal"], capacity: 16, heat: 200 },
    { id: "00000000-0000-0000-0000-0000000000ea", name: "Gryffindor Common Room", description: "Warm cozy common room with a roaring fireplace, red and gold decor, squishy sofas, bookshelves, and a winding staircase. Placeholder geometry — full 3D model coming.", tags: ["hogwarts", "social", "cozy"], capacity: 16, heat: 250 },
  ];

  for (const w of communityWorlds) {
    await prisma.world.upsert({
      where: { id: w.id },
      create: {
        id: w.id,
        authorId,
        name: w.name,
        description: w.description,
        tags: w.tags,
        capacity: w.capacity,
        releaseStatus: 2,
        isBuiltin: false,
        heat: w.heat,
      },
      update: { name: w.name, description: w.description, tags: w.tags, authorId, isBuiltin: false },
    });
  }

  console.log("seeded:");
  console.log(`  avatar ${avatar.id} — ${avatar.name}`);
  console.log(`  world  ${world.id} — ${world.name}`);
  for (const w of communityWorlds)
    console.log(`  world  ${w.id} — ${w.name}`);
  await seedSuisei();
  await prisma.$disconnect();
  redis.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
