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

  // Default world. Geometry lives on the CDN as a .serikaworld bundle (see upload-worlds.ts);
  // this row only carries the metadata.
  const world = await prisma.world.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000e0" },
    create: {
      id: "00000000-0000-0000-0000-0000000000e0",
      name: "The Commons",
      description: "The heart of Serika. A marble plaza under a great domed colonnade, a tiered fountain lit from within, gardens and lamplit benches on every side. Twelve pillars, endless conversations. Start here.",
      tags: ["hangout", "default", "social"],
      capacity: 48,
      releaseStatus: 2,
      isBuiltin: true,
      isDefaultHome: true, // placeholder default Home until a dedicated home world exists
      heat: 1000, // pin it to the top of the browser
    },
    update: { name: "The Commons", isDefaultHome: true },
  });

  // ── Community worlds by pikachubolk ─────────────────────────────────────────────
  // These are genuine public worlds (not builtin) attributed to pikachubolk. Geometry is
  // cloud-hosted: `bun src/upload-worlds.ts` builds each .serikaworld and registers its asset.

  const communityWorlds = [
    { id: "00000000-0000-0000-0000-0000000000e1", name: "Mirror Gallery", description: "A hall of eight true-reflection mirrors in gilded frames. Step onto the central pedestal and see your avatar from every angle — real-time reflections, not fakes. The place to show off a new outfit.", tags: ["mirror", "social"], capacity: 16, heat: 500 },
    { id: "00000000-0000-0000-0000-0000000000e2", name: "Serika Home", description: "The cosy house, opened up to friends. Crackling fireplace, a couch that seats three, armchairs, a bookshelf and a full-length mirror by the window. Sit down and stay a while.", tags: ["home", "social"], capacity: 12, heat: 400 },
    { id: "00000000-0000-0000-0000-0000000000e3", name: "Cinema", description: "A proper picture house: a 16-metre screen behind scarlet curtains, six raked rows of 48 real seats, glowing aisle strips and warm sconces. Grab a seat, the film's already rolling.", tags: ["video", "social", "cinema"], capacity: 48, heat: 300 },
    { id: "00000000-0000-0000-0000-0000000000e4", name: "Test: Empty Room", description: "A clean 40×40 hall with a glowing grid floor. The blank canvas for testing movement, collision and avatar scale.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e5", name: "Test: Pillar Maze", description: "A 7×7 grid of collidable pillars with the centre kept clear. For navigation, occlusion and pathfinding tests.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e6", name: "Test: Ramps", description: "Four platforms at rising heights joined by slopes. Tests slope collision, gravity, step-up and jump arcs.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e7", name: "Test: Color Grid", description: "A hundred hue-swept tiles in a 10×10 grid. Tests material rendering, colour accuracy and tone mapping.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e8", name: "Test: Sphere Garden", description: "Thirty scattered spheres plus three big translucent ones. Tests curved collision, transparency and sorting.", tags: ["test", "debug"], capacity: 16, heat: 100 },
    { id: "00000000-0000-0000-0000-0000000000e9", name: "Backrooms", description: "You noclipped out of reality. Endless mono-yellow hallways, damp moquette, the maddening 120Hz hum of fluorescent lights. 5+ million faithful triangles of pure liminal dread. Don't stop moving.", tags: ["maze", "horror", "liminal"], capacity: 24, heat: 900 },
    { id: "00000000-0000-0000-0000-0000000000ea", name: "Gryffindor Common Room", description: "The cosiest room in the castle. A roaring fireplace, scarlet-and-gold everything, squashy armchairs, tapestries and a spiral stair to the dorms. Fully modelled, fully textured. Pull up a chair.", tags: ["hogwarts", "social", "cozy"], capacity: 24, heat: 850 },
    { id: "00000000-0000-0000-0000-0000000000ec", name: "Test: Items Lab", description: "A test room for usable items and interaction parity: marker pens on tables, physics props to grab and throw, a large drawing wall, and a 1.8m reference post. Pick up a pen and draw!", tags: ["test", "debug", "items"], capacity: 16, heat: 100 },
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
