/** Publish a first-party SCRIPTED world.
 *
 *   bun --env-file=../.env src/publish-scripted-world.ts --bundle FILE --name "Rope Parkour" \
 *       [--world ID] [--description TEXT] [--capacity 4] [--tags a,b] [--publish --backup FILE]
 *
 * `publish-world-bundle.ts` deliberately refuses anything containing bytecode (`hasScript`), so
 * scripted content needs its own route. This is that route, and it follows the same policy the
 * upload endpoint applies rather than inventing a parallel one: `validateBundle` at the author's
 * rank, then `routeSubmission`, and only an AutoApproved decision is allowed to publish. Anything
 * that would have queued for a human here is refused instead of quietly bypassing review.
 *
 * Per threat T8, a top-rank auto-publish still writes an audit row — self-publishing is a
 * capability, not an exemption from the record.
 *
 * Dry run by default. `--publish` additionally requires `--backup`, written before any upload or
 * database mutation, exactly as the static publisher does.
 */
import { validateBundle, routeSubmission, ReviewStatus } from './review.ts';
import { prisma } from './db.ts';
import { audit } from './audit.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { putBytes, assetPublicUrl, storageConfigured } from './storage.ts';

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

const path = value('--bundle');
if (!path) throw new Error('--bundle is required');

const bytes = readFileSync(path);
if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Expected a .serikaworld ZIP');

// Rank 8 = VerifiedCreator, the floor for publishing scripted content without review. First-party
// bundles are built in this repo, which is the case gate 5 of docs/serikascript.md scopes OUT of
// the untrusted-authorship rules — but the bytecode is still fully validated, because the client
// will validate it again and a mismatch here would just fail later and more confusingly.
const RANK = 8;
const report = validateBundle(bytes, RANK);
const routing = routeSubmission(RANK, report, /* isAdmin */ true);

if (!report.ok) throw new Error(`Bundle validation failed: ${JSON.stringify(report.errors)}`);
if (!report.hasScript) throw new Error('No script found — use publish-world-bundle.ts for static worlds');
if (routing.reviewStatus !== ReviewStatus.AutoApproved) {
  throw new Error(`Routing says ${routing.reviewStatus}, not AutoApproved — refusing to bypass review`);
}

const hash = createHash('sha256').update(bytes).digest('hex');
const key = `wl/${hash.slice(0, 2)}/${hash}/world.serikaworld`;

const worldId = value('--world');
const name = value('--name');
const description = value('--description') ?? '';
const capacity = Number(value('--capacity') ?? 4);
const tags = (value('--tags') ?? '').split(',').map(t => t.trim()).filter(Boolean);

if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
  throw new Error(`--capacity must be an integer 1..64, got ${value('--capacity')}`);
}

try {
  const existing = worldId ? await prisma.world.findUnique({ where: { id: worldId } }) : null;
  if (worldId && !existing) throw new Error(`No world ${worldId}`);
  if (!worldId && !name) throw new Error('--name is required when creating a new world');

  const latest = existing
    ? await prisma.worldVersion.findFirst({ where: { worldId: existing.id }, orderBy: { version: 'desc' } })
    : null;
  const versionNumber = (latest?.version ?? 0) + 1;

  console.log(JSON.stringify({
    mode: existing ? 'update' : 'create',
    worldId: existing?.id ?? '(new)',
    name: name ?? existing?.name,
    capacity,
    tags,
    nextVersion: versionNumber,
    bytes: bytes.length,
    sha256: hash,
    url: assetPublicUrl(key),
    scripts: report.scripts.map(s => ({
      name: s.name,
      ok: s.validation.ok,
      hooks: s.validation.hooks,
      hostCalls: s.validation.hostCalls?.map(h => `0x${h.toString(16)}`),
      budgetTick: s.validation.budgetTick,
    })),
    routing: routing.reviewStatus,
    publish: args.includes('--publish'),
  }, null, 2));

  if (!args.includes('--publish')) {
    console.log('\nDry run. Re-run with --publish --backup FILE to apply.');
  } else {
    if (!storageConfigured) throw new Error('Production storage is not configured');
    const backup = value('--backup');
    if (!backup) throw new Error('--backup FILE is required when publishing');
    writeFileSync(backup, JSON.stringify({ existing, latest }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));

    await putBytes(key, bytes, 'application/zip');

    // Read it back from the CDN and compare bytes. An upload that "succeeded" but serves
    // something else is the failure mode that costs a debugging cycle later.
    const response = await fetch(assetPublicUrl(key), { headers: { 'User-Agent': 'SerikaWorldPublisher/1.0' } });
    if (!response.ok) throw new Error(`CDN verification failed: ${response.status}`);
    const remoteHash = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
    if (remoteHash !== hash) throw new Error('CDN checksum mismatch');

    const finalId = await prisma.$transaction(async tx => {
      const world = existing ?? await tx.world.create({
        data: {
          name: name!,
          description,
          tags,
          capacity,
          releaseStatus: 2, // public
        },
      });

      const version = await tx.worldVersion.create({
        data: {
          worldId: world.id,
          version: versionNumber,
          buildStatus: 2,
          reviewStatus: 2,
          hasScript: true,
          validatorReport: JSON.parse(JSON.stringify(report)),
          reviewNotes: 'First-party scripted world; bytecode built in-repo by tools/serikascript and verified in the Godot client.',
          assets: {
            create: [0, 1, 2].map(platform => ({
              platform,
              blake3: Buffer.from(hash, 'hex'),
              bytes: BigInt(bytes.length),
              cdnKey: key,
            })),
          },
        },
      });

      // Optimistic concurrency, same as the static publisher: if anything moved the published
      // pointer while we were uploading, roll back rather than clobber it.
      const changed = await tx.world.updateMany({
        where: { id: world.id, publishedVersionId: existing?.publishedVersionId ?? null },
        data: {
          publishedVersionId: version.id,
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          capacity,
          ...(tags.length ? { tags } : {}),
        },
      });
      if (changed.count !== 1) throw new Error('World changed during publish; transaction rolled back');
      return world.id;
    });

    // T8: a rank-8 self-publish still leaves a record.
    await audit('world.publish_scripted', {
      subjectId: finalId,
      detail: { version: versionNumber, sha256: hash, scripts: report.scripts.map(s => s.name), capacity },
    });

    console.log(`\nPublished scripted world ${finalId} version ${versionNumber}; CDN SHA-256 verified.`);
  }
} finally {
  await prisma.$disconnect();
  // Prisma's pool keeps the loop alive even after disconnect, so a one-shot script hangs
  // forever after doing its work. Exit explicitly rather than leaving the caller to time out.
  process.exit(0);
}
