import { Elysia, t } from "elysia";
import { readFile } from "node:fs/promises";
import { authed, adminOnly } from "../auth-plugin.ts";
import { prisma } from "../db.ts";
import { putBytes, assetPublicUrl, localAssetPath, getObjectBytes } from "../storage.ts";
import { vrmOrGlbToSka, sniffKind } from "../ska.ts";

// Avatar catalogue + upload → `.ska` conversion.
//
// Uploaded VRM/GLB humanoids are converted to Serika's `.ska` container in-process (small files),
// stored, and recorded as an Avatar + published AvatarVersion. Binary FBX is detected and rejected
// with guidance unless an external FBX2glTF step is wired later — VRM/GLB cover the common case.

const MAX_AVATAR_BYTES = 64 * 1024 * 1024;

function skaKeyFor(hashHex: string): string {
  return `av/${hashHex.slice(0, 2)}/${hashHex}.ska`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Source-format code stored on Avatar.sourceFormat: 0=builtin 1=vrm 2=gltf 3=fbx
const formatCode = (src: string): number => (src === "vrm0" || src === "vrm1" ? 1 : src === "glb" ? 2 : 0);

/// Shape a DB avatar row (with its published version) into the API's public JSON.
function serialize(a: any) {
  const version = a.versions?.[0];
  const stats = (version?.stats ?? {}) as Record<string, unknown>;
  return {
    id: a.id,
    name: a.name,
    author: a.author?.username ?? "unknown",
    authorId: a.authorId,
    sourceFormat: a.sourceFormat,
    perfRank: a.perfRank,
    isBuiltin: a.isBuiltin,
    isDefaultOutfit: a.isDefaultOutfit,
    releaseStatus: a.releaseStatus,
    thumbnailUrl: a.thumbnailKey ? assetPublicUrl(a.thumbnailKey) : null,
    downloadUrl: version?.cdnKey ? assetPublicUrl(version.cdnKey) : null,
    heightMeters: stats.heightMeters ?? null,
    createdAt: a.createdAt,
  };
}

const withVersion = {
  author: { select: { username: true } },
  versions: { orderBy: { version: "desc" as const }, take: 1 },
};

// ── Public catalogue + file serving (no auth) ─────────────────────────────────────────────

export const avatarPublicRoutes = new Elysia({ prefix: "/v1/avatars" })
  // The "goated" avatars page feeds off this: public avatars + curated default outfits first.
  .get(
    "/",
    async ({ query }) => {
      const take = Math.min(Number(query.limit ?? 60), 120);
      const avatars = await prisma.avatar.findMany({
        where: { OR: [{ releaseStatus: 2 }, { isDefaultOutfit: true }, { isBuiltin: true }] },
        include: withVersion,
        orderBy: [{ isDefaultOutfit: "desc" }, { createdAt: "desc" }],
        take,
      });
      return { avatars: avatars.map(serialize) };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )
  .get("/:id", async ({ params, set }) => {
    const a = await prisma.avatar.findUnique({ where: { id: params.id }, include: withVersion });
    if (!a) { set.status = 404; return { error: "not_found" }; }
    return serialize(a);
  })
  .get("/:id/file", async ({ params, set }) => {
    const a = await prisma.avatar.findUnique({ where: { id: params.id }, include: withVersion });
    if (!a || !a.versions?.[0]?.cdnKey) { set.status = 404; return { error: "not_found" }; }
    const bytes = await getObjectBytes(a.versions[0].cdnKey);
    if (!bytes) { set.status = 404; return { error: "file_missing" }; }
    set.headers["content-type"] = "application/octet-stream";
    set.headers["cache-control"] = "public, max-age=31536000, immutable";
    return new Response(bytes as BufferSource);
  });

// Local-disk asset serving fallback (used when B2/CDN isn't configured). Content-addressed keys
// are immutable, so cache hard. Not mounted behind auth — `.ska`/thumbnails are public assets.
export const assetFileRoutes = new Elysia({ prefix: "/v1/assets/file" }).get(
  "/*",
  async ({ params, set }) => {
    const key = (params as any)["*"] as string;
    try {
      const bytes = await readFile(localAssetPath(key));
      set.headers["content-type"] = key.endsWith(".ska") ? "application/octet-stream" : "application/octet-stream";
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return new Response(bytes);
    } catch {
      set.status = 404;
      return { error: "not_found" };
    }
  },
);

// ── Authenticated: my avatars, upload, select ─────────────────────────────────────────────

export const avatarRoutes = new Elysia({ prefix: "/v1/avatars" })
  .use(authed)
  // The avatar the game should equip for this user: their chosen one, else the newest default
  // outfit (so nobody is a capsule). Returns { avatar } or { avatar: null }.
  .get("/current", async ({ session }) => {
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { currentAvatarId: true },
    });
    let avatar = null;
    if (user?.currentAvatarId) {
      avatar = await prisma.avatar.findUnique({ where: { id: user.currentAvatarId }, include: withVersion });
    }
    if (!avatar) {
      avatar = await prisma.avatar.findFirst({
        where: { isDefaultOutfit: true },
        include: withVersion,
        orderBy: { createdAt: "desc" },
      });
    }
    return { avatar: avatar ? serialize(avatar) : null };
  })
  .get("/mine/list", async ({ session }) => {
    const avatars = await prisma.avatar.findMany({
      where: { authorId: session.sub },
      include: withVersion,
      orderBy: { createdAt: "desc" },
    });
    return { avatars: avatars.map(serialize) };
  })

  // Upload a VRM/GLB (multipart `file`), convert to `.ska`, store, and record it.
  .post(
    "/upload",
    async ({ body, session, set }) => {
      const file = body.file as File;
      if (!file) { set.status = 400; return { error: "missing_file" }; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX_AVATAR_BYTES) { set.status = 413; return { error: "too_large", maxBytes: MAX_AVATAR_BYTES }; }

      const kind = sniffKind(bytes);
      if (kind === "fbx") {
        set.status = 415;
        return { error: "fbx_not_supported", detail: "FBX upload needs conversion to glTF first. Export your rig as VRM or GLB and re-upload." };
      }
      if (kind === "unknown") {
        set.status = 415;
        return { error: "unsupported_format", detail: "Upload a VRM or a binary glTF (.glb) humanoid." };
      }

      let result;
      try {
        result = vrmOrGlbToSka(bytes, { name: body.name });
      } catch (e) {
        set.status = 422;
        return { error: "conversion_failed", detail: e instanceof Error ? e.message : String(e) };
      }

      const hash = await sha256Hex(result.ska);
      const key = skaKeyFor(hash);
      await putBytes(key, result.ska, "application/octet-stream");

      const avatar = await prisma.avatar.create({
        data: {
          authorId: session.sub,
          name: result.meta.name,
          sourceFormat: formatCode(result.meta.sourceFormat),
          releaseStatus: 0, // private until the author publishes
          versions: {
            create: {
              version: 1,
              cdnKey: key,
              blake3: Buffer.from(hash, "hex"),
              stats: {
                heightMeters: result.meta.heightMeters,
                eyeHeightMeters: result.meta.eyeHeightMeters,
                boneCount: Object.keys(result.meta.humanoid).length,
                sizeBytes: result.ska.length,
              },
            },
          },
        },
        include: withVersion,
      });
      // Point the freshly created avatar at its version as published.
      await prisma.avatar.update({
        where: { id: avatar.id },
        data: { publishedVersionId: avatar.versions[0].id },
      });

      return { avatar: serialize(avatar) };
    },
    { body: t.Object({ file: t.File(), name: t.Optional(t.String()) }) },
  )

  // Set the caller's currently-worn avatar.
  .post(
    "/:id/select",
    async ({ params, session, set }) => {
      const a = await prisma.avatar.findUnique({ where: { id: params.id } });
      if (!a) { set.status = 404; return { error: "not_found" }; }
      // Must be public, a default outfit, builtin, or owned by the caller.
      const usable = a.releaseStatus === 2 || a.isDefaultOutfit || a.isBuiltin || a.authorId === session.sub;
      if (!usable) { set.status = 403; return { error: "not_permitted" }; }
      await prisma.user.update({ where: { id: session.sub }, data: { currentAvatarId: params.id } });
      return { ok: true, currentAvatarId: params.id };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // Publish / unpublish one of the caller's own avatars.
  .post(
    "/:id/release",
    async ({ params, body, session, set }) => {
      const a = await prisma.avatar.findUnique({ where: { id: params.id } });
      if (!a || a.authorId !== session.sub) { set.status = 404; return { error: "not_found" }; }
      await prisma.avatar.update({ where: { id: params.id }, data: { releaseStatus: body.status } });
      return { ok: true };
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ status: t.Integer({ minimum: 0, maximum: 2 }) }) },
  );

// ── Admin: manage default outfits and the default Home world ───────────────────────────────

export const adminRoutes = new Elysia({ prefix: "/v1/admin" })
  .use(adminOnly)
  .get("/overview", async () => {
    const [defaultOutfits, defaultHome, avatarCount, worldCount] = await Promise.all([
      prisma.avatar.findMany({ where: { isDefaultOutfit: true }, include: withVersion }),
      prisma.world.findFirst({ where: { isDefaultHome: true } }),
      prisma.avatar.count(),
      prisma.world.count(),
    ]);
    return {
      defaultOutfits: defaultOutfits.map(serialize),
      defaultHome: defaultHome ? { id: defaultHome.id, name: defaultHome.name } : null,
      counts: { avatars: avatarCount, worlds: worldCount },
    };
  })

  // Toggle whether an avatar is offered to everyone as a default outfit.
  .post(
    "/avatars/:id/default-outfit",
    async ({ params, body, set }) => {
      const a = await prisma.avatar.findUnique({ where: { id: params.id } });
      if (!a) { set.status = 404; return { error: "not_found" }; }
      await prisma.avatar.update({ where: { id: params.id }, data: { isDefaultOutfit: body.enabled } });
      return { ok: true, id: params.id, isDefaultOutfit: body.enabled };
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ enabled: t.Boolean() }) },
  )

  // Choose the single default Home world (clears the flag on any previous one).
  .post(
    "/worlds/:id/default-home",
    async ({ params, set }) => {
      const w = await prisma.world.findUnique({ where: { id: params.id } });
      if (!w) { set.status = 404; return { error: "not_found" }; }
      await prisma.$transaction([
        prisma.world.updateMany({ where: { isDefaultHome: true }, data: { isDefaultHome: false } }),
        prisma.world.update({ where: { id: params.id }, data: { isDefaultHome: true } }),
      ]);
      return { ok: true, defaultHomeId: params.id };
    },
    { params: t.Object({ id: t.String() }) },
  );
