/**
 * upload-worlds.ts — Build (if needed), upload, and register the real 3D worlds as
 * cloud-downloadable `.serikaworld` bundles, OVERRIDING their DB rows.
 *
 * Usage: bun src/upload-worlds.ts
 *
 * A `.serikaworld` is a ZIP { world.glb (embedded textures), manifest.json }. This script:
 *   1. Ensures the bundle exists (runs tools/convert_world.py via Blender if missing).
 *   2. Uploads it to B2/CDN (content-addressed by sha256).
 *   3. Upserts the World row (name/description/tags/spawn author) — overriding what's there.
 *   4. Creates a published WorldVersion + cross-platform WorldAsset rows so the API serves
 *      a downloadUrl the client fetches as `{worldId}.serikaworld`.
 */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { prisma } from "./db.ts";
import { putBytes, assetPublicUrl, storageConfigured } from "./storage.ts";

const W3D = "/media/pikachubolk/63d7930c-4cfb-4c68-96a6-879048200e36/root-files/Documents/Models/3DWorlds";
const BUILT = `${W3D}/SerikaWorlds/built`;

interface WorldSpec {
  worldId: string;
  name: string;
  description: string;
  tags: string[];
  capacity: number;
  heat: number;
  /** The shipped gathering place — keeps its badge and default-home role. */
  isBuiltin?: boolean;
}

const WORLDS: WorldSpec[] = [
  {
    worldId: "00000000-0000-0000-0000-0000000000e0",
    name: "The Commons",
    description:
      "The heart of Serika. A marble plaza under a great domed colonnade, a tiered fountain lit from within, gardens and lamplit benches on every side. Twelve pillars, endless conversations. Start here.",
    tags: ["hangout", "default", "social"],
    capacity: 48,
    heat: 1000,
    isBuiltin: true,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e1",
    name: "Mirror Gallery",
    description:
      "A hall of eight true-reflection mirrors in gilded frames. Step onto the central pedestal and see your avatar from every angle — real-time reflections, not fakes. The place to show off a new outfit.",
    tags: ["mirror", "avatar", "social"],
    capacity: 16,
    heat: 700,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e2",
    name: "Serika Home",
    description:
      "The cosy house, opened up to friends. Crackling fireplace, a couch that seats three, armchairs, a bookshelf and a full-length mirror by the window. Sit down and stay a while.",
    tags: ["home", "cozy", "social"],
    capacity: 12,
    heat: 650,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e3",
    name: "Cinema",
    description:
      "A proper picture house: an 11-metre screen framed by deep violet curtains, seven raked rows of 112 real seats, step lights down the aisle and a cove-lit ceiling. Grab a seat, the film's already rolling.",
    tags: ["video", "cinema", "watch-party"],
    capacity: 64,
    heat: 800,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e4",
    name: "Test: Empty Room",
    description: "A clean 40×40 hall with a glowing grid floor. The blank canvas for testing movement, collision and avatar scale.",
    tags: ["test", "debug"],
    capacity: 16,
    heat: 100,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e5",
    name: "Test: Pillar Maze",
    description: "A 7×7 grid of collidable pillars with the centre kept clear. For navigation, occlusion and pathfinding tests.",
    tags: ["test", "debug"],
    capacity: 16,
    heat: 100,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e6",
    name: "Test: Ramps",
    description: "Four platforms at rising heights joined by slopes. Tests slope collision, gravity, step-up and jump arcs.",
    tags: ["test", "debug"],
    capacity: 16,
    heat: 100,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e7",
    name: "Test: Color Grid",
    description: "A hundred hue-swept tiles in a 10×10 grid. Tests material rendering, colour accuracy and tone mapping.",
    tags: ["test", "debug"],
    capacity: 16,
    heat: 100,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e8",
    name: "Test: Sphere Garden",
    description: "Thirty scattered spheres plus three big translucent ones. Tests curved collision, transparency and sorting.",
    tags: ["test", "debug"],
    capacity: 16,
    heat: 100,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000eb",
    name: "Test: Video Room",
    description:
      "A bare room with one 6.4×3.6 m screen and four seats. The control case for video problems: if a clip plays here but not in the Cinema, the fault is the Cinema's geometry, not the player. The yellow post is exactly 1.8 m for checking avatar scale.",
    tags: ["test", "debug", "video"],
    capacity: 16,
    heat: 100,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000e9",
    name: "Backrooms",
    description:
      "You noclipped out of reality. Endless mono-yellow hallways, damp moquette, the maddening 120Hz hum of fluorescent lights. 5+ million faithful triangles of pure liminal dread. Don't stop moving.",
    tags: ["maze", "horror", "liminal"],
    capacity: 24,
    heat: 900,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000ea",
    name: "Gryffindor Common Room",
    description:
      "The cosiest room in the castle. A roaring fireplace, scarlet-and-gold everything, squashy armchairs, tapestries and a spiral stair to the dorms. Fully modelled, fully textured. Pull up a chair.",
    tags: ["hogwarts", "social", "cozy"],
    capacity: 24,
    heat: 850,
  },
  {
    worldId: "00000000-0000-0000-0000-0000000000ec",
    name: "Test: Items Lab",
    description:
      "A test room for usable items and interaction parity: marker pens on tables, physics props to grab and throw, a large drawing wall, and a 1.8m reference post. Pick up a pen and draw!",
    tags: ["test", "debug", "items"],
    capacity: 16,
    heat: 100,
  },
];

/** Locate the pre-built `.serikaworld`; build the whole set via Blender if it is missing. */
function ensureBundle(w: WorldSpec): string {
  const byId = `${BUILT}/${w.worldId}.serikaworld`;
  if (existsSync(byId)) return byId;

  console.log(`  Bundle missing — running build_all_worlds.sh …`);
  const script = new URL("../../../tools/build_all_worlds.sh", import.meta.url).pathname;
  const r = spawnSync("bash", [script], { stdio: "inherit" });
  if (r.status !== 0 || !existsSync(byId)) throw new Error(`no bundle for ${w.name} (${byId})`);
  return byId;
}

async function uploadWorld(w: WorldSpec, authorId: string | null) {
  const bundlePath = ensureBundle(w);
  await stat(bundlePath);
  const bytes = await readFile(bundlePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = `wl/${hash.slice(0, 2)}/${hash}/world.serikaworld`;

  console.log(`  Uploading ${w.name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) → ${key}`);
  await putBytes(key, bytes, "application/zip");
  const downloadUrl = assetPublicUrl(key);
  console.log(`  CDN URL: ${downloadUrl}`);

  // 1. Upsert (override) the World row.
  await prisma.world.upsert({
    where: { id: w.worldId },
    create: {
      id: w.worldId,
      name: w.name,
      description: w.description,
      tags: w.tags,
      capacity: w.capacity,
      heat: w.heat,
      releaseStatus: 2, // public
      isBuiltin: w.isBuiltin ?? false,
      authorId,
    },
    update: {
      name: w.name,
      description: w.description,
      tags: w.tags,
      capacity: w.capacity,
      heat: w.heat,
      releaseStatus: 2,
      isBuiltin: w.isBuiltin ?? false,
      authorId,
    },
  });

  // 2. New published version. Version number climbs so re-runs are safe & idempotent-ish.
  const latest = await prisma.worldVersion.findFirst({
    where: { worldId: w.worldId },
    orderBy: { version: "desc" },
  });
  const versionNumber = (latest?.version ?? 0) + 1;

  // Skip re-upload if the newest ready version already points at this exact hash.
  const existingAsset = latest && latest.buildStatus === 2
    ? await prisma.worldAsset.findFirst({ where: { versionId: latest.id } })
    : null;
  if (existingAsset?.cdnKey === key) {
    console.log(`  = ${w.name} already at this build (${key}); ensuring publishedVersionId`);
    await prisma.world.update({ where: { id: w.worldId }, data: { publishedVersionId: latest!.id } });
    return;
  }

  const blake3 = Buffer.from(hash, "hex"); // reuse sha256 digest in the blake3 column
  const version = await prisma.worldVersion.create({
    data: {
      worldId: w.worldId,
      version: versionNumber,
      buildStatus: 2, // ready/published
      assets: {
        create: [0, 1, 2].map((platform) => ({
          platform, // 0=windows 1=linux 2=android — the bundle is cross-platform
          blake3,
          bytes: BigInt(bytes.length),
          cdnKey: key,
        })),
      },
    },
  });

  await prisma.world.update({
    where: { id: w.worldId },
    data: { publishedVersionId: version.id },
  });

  console.log(`  ✓ ${w.name} uploaded & registered (version ${versionNumber})`);
}

async function main() {
  if (!storageConfigured) {
    console.warn("⚠ Storage not configured (B2_* env unset) — writing to LOCAL_ASSET_DIR.");
  }

  const pikachubolk = await prisma.user.findFirst({ where: { username: "pikachubolk" } });
  const authorId = pikachubolk?.id ?? null;
  if (!authorId) console.warn("⚠ pikachubolk user not found — worlds will have no author.");

  console.log("Uploading real 3D worlds…\n");
  for (const w of WORLDS) {
    console.log(`\nProcessing: ${w.name} (${w.worldId})`);
    try {
      await uploadWorld(w, authorId);
    } catch (e) {
      console.error(`  ✗ ${w.name}: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log("\nDone.");
  await prisma.$disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
