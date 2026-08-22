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

  console.log("seeded:");
  console.log(`  avatar ${avatar.id} — ${avatar.name}`);
  console.log(`  world  ${world.id} — ${world.name}`);
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
