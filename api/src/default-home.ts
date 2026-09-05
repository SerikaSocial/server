import { PUBLISHED_STATES } from "./review.ts";
import type { Prisma } from "@prisma/client";

// Include the approved versions, then select the exact published pointer below. A newer
// upload or draft must never silently replace the Home that an administrator selected.
export const defaultHomeInclude = {
  versions: { where: { buildStatus: 2, reviewStatus: { in: [...PUBLISHED_STATES] } }, include: { assets: true } },
} satisfies Prisma.WorldInclude;

type HomeWorld = {
  id: string;
  name: string;
  releaseStatus: number;
  publishedVersionId: string | null;
  versions: {
    id: string;
    buildStatus: number;
    reviewStatus: number;
    assets: { platform: number; cdnKey: string }[];
  }[];
};

/** Only a public, approved, ready publication can become everybody's arrival world. */
export function defaultHomeEntry(world: HomeWorld | null, publicUrl: (key: string) => string) {
  if (!world || world.releaseStatus !== 2 || !world.publishedVersionId) return null;
  const version = world.versions.find((v) => v.id === world.publishedVersionId);
  if (!version || version.buildStatus !== 2 || !PUBLISHED_STATES.has(version.reviewStatus)) return null;
  // Current .serikaworld GLB bundles are portable; prefer the desktop/Linux asset and
  // fall back to another platform when that is the only published bundle.
  const asset = version.assets.find((a) => a.platform === 1 && a.cdnKey)
    ?? version.assets.find((a) => a.cdnKey);
  if (!asset) return null;
  return { id: world.id, name: world.name, versionId: version.id, downloadUrl: publicUrl(asset.cdnKey) };
}

/** Seeding can fill an empty registry, but must preserve an administrator's choice. */
export function seedHomeSelection(existingDefaultId: string | null) {
  return existingDefaultId === null ? { isDefaultHome: true } : {};
}
