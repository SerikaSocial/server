import { describe, expect, test } from "bun:test";
import { defaultHomeEntry, seedHomeSelection } from "./default-home.ts";

const url = (key: string) => `https://cdn.example/${key}`;
const published = () => ({
  id: "world", name: "Arrival Hub", releaseStatus: 2, publishedVersionId: "published",
  versions: [
    { id: "new-draft", buildStatus: 2, reviewStatus: 0, assets: [{ platform: 1, cdnKey: "draft.serikaworld" }] },
    { id: "published", buildStatus: 2, reviewStatus: 2, assets: [{ platform: 1, cdnKey: "approved.serikaworld" }] },
  ],
});

describe("default Home registry", () => {
  test("uses the exact publication, never a newer draft", () => {
    expect(defaultHomeEntry(published(), url)).toEqual({ id: "world", name: "Arrival Hub", versionId: "published", downloadUrl: url("approved.serikaworld") });
  });
  test("fails closed for unpublished, private, rejected or missing assets", () => {
    expect(defaultHomeEntry(null, url)).toBeNull();
    for (const releaseStatus of [0, 1]) expect(defaultHomeEntry({ ...published(), releaseStatus }, url)).toBeNull();
    expect(defaultHomeEntry({ ...published(), publishedVersionId: null }, url)).toBeNull();
    for (const change of [{ buildStatus: 1 }, { reviewStatus: 6 }, { assets: [] }]) {
      const world = published();
      Object.assign(world.versions[1]!, change);
      expect(defaultHomeEntry(world, url)).toBeNull();
    }
  });
  test("allows a reviewed publication and a portable alternative platform", () => {
    const world = published();
    world.versions[1]!.reviewStatus = 5;
    world.versions[1]!.assets[0]!.platform = 0;
    expect(defaultHomeEntry(world, url)?.downloadUrl).toBe(url("approved.serikaworld"));
  });
  test("reseed preserves an administrator-selected hub and does not create a second default", () => {
    expect(seedHomeSelection("hub-id")).toEqual({});
    expect(seedHomeSelection("commons-id")).toEqual({});
    expect(seedHomeSelection(null)).toEqual({ isDefaultHome: true });
  });
});
