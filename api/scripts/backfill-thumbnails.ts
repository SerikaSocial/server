/**
 * One-off script: backfill avatar thumbnails from embedded VRM/GLB data,
 * and remove the old "Serika (default)" avatar from the DB.
 *
 * Run: cd server && bun run api/scripts/backfill-thumbnails.ts
 */
import { PrismaClient } from "@prisma/client";
import { putBytes, getObjectBytes } from "../src/storage.ts";
import { extractThumbnail } from "../src/ska.ts";

const prisma = new PrismaClient();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function parseSkaGlb(skaBytes: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(skaBytes.buffer, skaBytes.byteOffset, skaBytes.byteLength);
  const magic = new TextDecoder("latin1").decode(skaBytes.subarray(0, 4));
  if (magic !== "SKA1") throw new Error("not a .ska file");
  const metaLen = dv.getUint32(8, true);
  const glbLenOffset = 12 + metaLen;
  const glbLen = dv.getUint32(glbLenOffset, true);
  const glbStart = glbLenOffset + 4;
  return skaBytes.subarray(glbStart, glbStart + glbLen);
}

async function main() {
  console.log("=== Backfill Thumbnails ===\n");

  // 1. Remove the old "Serika (default)" avatar
  const serikaId = "00000000-0000-0000-0000-0000000000a0";
  console.log(`[1/2] Removing "Serika (default)" avatar (${serikaId})...`);
  try {
    const serika = await prisma.avatar.findUnique({ where: { id: serikaId } });
    if (serika) {
      const cleared = await prisma.user.updateMany({
        where: { currentAvatarId: serikaId },
        data: { currentAvatarId: null },
      });
      console.log(`  Cleared ${cleared.count} user(s) pointing to it`);
      const deletedVersions = await prisma.avatarVersion.deleteMany({
        where: { avatarId: serikaId },
      });
      console.log(`  Deleted ${deletedVersions.count} version(s)`);
      await prisma.avatar.delete({ where: { id: serikaId } });
      console.log(`  ✓ Deleted "Serika (default)"\n`);
    } else {
      console.log(`  Already removed\n`);
    }
  } catch (e) {
    console.error(`  ✗ Error deleting Serika default: ${e}\n`);
  }

  // 2. Backfill thumbnails for remaining avatars
  console.log("[2/2] Backfilling thumbnails...");
  const avatars = await prisma.avatar.findMany({
    where: { thumbnailKey: null },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });

  console.log(`  Found ${avatars.length} avatars without thumbnails\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const a of avatars) {
    const version = a.versions[0];
    if (!version?.cdnKey) {
      console.log(`  ✗ ${a.name} (${a.id}): no file version — skipping`);
      skipped++;
      continue;
    }

    console.log(`  → ${a.name} (${a.id})`);
    console.log(`    cdnKey: ${version.cdnKey}`);

    let skaBytes: Uint8Array | null = null;
    try {
      skaBytes = await getObjectBytes(version.cdnKey);
    } catch (e) {
      console.log(`    ✗ Storage error: ${e}`);
      failed++;
      continue;
    }

    if (!skaBytes) {
      console.log(`    ✗ File not found in storage`);
      failed++;
      continue;
    }

    console.log(`    .ska size: ${skaBytes.length} bytes`);

    try {
      const glbBytes = await parseSkaGlb(skaBytes);
      console.log(`    GLB size: ${glbBytes.length} bytes`);

      const thumb = extractThumbnail(glbBytes);
      if (!thumb) {
        console.log(`    ⊘ No embedded thumbnail found — skipping`);
        skipped++;
        continue;
      }

      console.log(`    Thumbnail: ${thumb.bytes.length} bytes (${thumb.mimeType})`);

      const thumbHash = await sha256Hex(thumb.bytes);
      const ext = thumb.mimeType === "image/jpeg" ? "jpg" : "png";
      const thumbKey = `av/thumb/${thumbHash.slice(0, 2)}/${thumbHash}.${ext}`;

      await putBytes(thumbKey, thumb.bytes, thumb.mimeType);
      await prisma.avatar.update({
        where: { id: a.id },
        data: { thumbnailKey: thumbKey },
      });

      console.log(`    ✓ Thumbnail stored at ${thumbKey}`);
      success++;
    } catch (e) {
      console.log(`    ✗ Error: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Thumbnails added: ${success}`);
  console.log(`  Skipped (no thumb/no file): ${skipped}`);
  console.log(`  Failed: ${failed}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
