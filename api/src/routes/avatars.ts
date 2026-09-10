import { Elysia, t } from "elysia";
import { readFile } from "node:fs/promises";
import { authed, adminOnly } from "../auth-plugin.ts";
import { prisma } from "../db.ts";
import { putBytes, assetPublicUrl, imagePublicUrl, localAssetPath, getObjectBytes } from "../storage.ts";
import { vrmOrGlbToSka, pmxToSka, sniffKind, extractThumbnail, maybeGunzip } from "../ska.ts";
import { parsePMX } from "../pmx.ts";
import { unzipSync } from "fflate";
import { extname } from "node:path";
import { requireTrust, TrustError, TRUST_TO_UPLOAD, trustLabel, MAX_TRUST } from "../trust.ts";
import { defaultHomeEntry, defaultHomeInclude } from "../default-home.ts";

// Avatar catalogue + upload → `.ska` conversion.
//
// Uploaded VRM/GLB humanoids are converted to Serika's `.ska` container in-process (small files),
// stored, and recorded as an Avatar + published AvatarVersion. Binary FBX is detected and rejected
// with guidance unless an external FBX2glTF step is wired later — VRM/GLB cover the common case.

const MAX_AVATAR_BYTES = 64 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/// Extract a PMX file and its textures from a zip buffer.
/// Returns { pmxBytes, textureBytes } where textureBytes maps texture index → { bytes, mimeType }.
function extractPmxZip(zipBytes: Uint8Array): { pmxBytes: Uint8Array; textureBytes: Map<number, { bytes: Uint8Array; mimeType: string }> } {
  const files = unzipSync(zipBytes);
  // Find the .pmx file (prefer the one at the root or shallowest path)
  let pmxPath: string | null = null;
  let pmxDepth = Infinity;
  for (const path of Object.keys(files)) {
    if (path.toLowerCase().endsWith(".pmx")) {
      const depth = path.split("/").length;
      if (depth < pmxDepth) { pmxDepth = depth; pmxPath = path; }
    }
  }
  if (!pmxPath) throw new Error("no .pmx file found in the zip archive");
  const pmxBytes = files[pmxPath];
  const pmxDir = pmxPath.includes("/") ? pmxPath.slice(0, pmxPath.lastIndexOf("/") + 1) : "";

  // Parse the PMX to get texture paths, then load matching files from the zip
  const model = parsePMX(pmxBytes as Uint8Array);
  const textureBytes = new Map<number, { bytes: Uint8Array; mimeType: string }>();
  for (let i = 0; i < model.textures.length; i++) {
    const texPath = model.textures[i].path.replace(/\\/g, "/");
    // Try: (1) relative to PMX dir, (2) relative to zip root, (3) basename match
    const candidates = [
      pmxDir + texPath,
      texPath,
      texPath.split("/").pop()!,
      pmxDir + texPath.split("/").pop()!,
    ];
    for (const candidate of candidates) {
      // Also try case-insensitive match
      let found = files[candidate];
      if (!found) {
        const lower = candidate.toLowerCase();
        for (const key of Object.keys(files)) {
          if (key.toLowerCase() === lower) { found = files[key]; break; }
        }
      }
      if (found) {
        const ext = extname(texPath).toLowerCase();
        const mimeType = IMAGE_MIME[ext] ?? "application/octet-stream";
        textureBytes.set(i, { bytes: found as Uint8Array, mimeType });
        break;
      }
    }
  }
  return { pmxBytes: pmxBytes as Uint8Array, textureBytes };
}

function skaKeyFor(hashHex: string): string {
  return `av/${hashHex.slice(0, 2)}/${hashHex}.ska`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Source-format code stored on Avatar.sourceFormat: 0=builtin 1=vrm 2=gltf 3=fbx 4=pmx
const formatCode = (src: string): number => (src === "vrm0" || src === "vrm1" ? 1 : src === "glb" ? 2 : src === "pmx" ? 4 : 0);

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
    thumbnailUrl: a.thumbnailKey ? imagePublicUrl(a.thumbnailKey, { w: 512, h: 512 }) : null,
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
  // The avatar a given user is currently wearing. The game calls this when a peer joins an
  // instance so each remote player renders as themselves — the relay only carries the peer's
  // user id, not their avatar, and without this every remote wore the local player's model.
  // Falls back to the newest default outfit so a peer is never a capsule.
  .get(
    "/by-user/:userId",
    async ({ params }) => {
      const user = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { currentAvatarId: true },
      });
      let avatar = user?.currentAvatarId
        ? await prisma.avatar.findUnique({ where: { id: user.currentAvatarId }, include: withVersion })
        : null;
      if (!avatar) {
        avatar = await prisma.avatar.findFirst({
          where: { isDefaultOutfit: true },
          include: withVersion,
          orderBy: { createdAt: "desc" },
        });
      }
      return { avatar: avatar ? serialize(avatar) : null };
    },
    { params: t.Object({ userId: t.String() }) },
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

  // Upload a VRM/GLB/PMX (multipart `file`), convert to `.ska`, store, and record it.
  // For PMX models with external textures, upload a .zip containing the .pmx + texture folder.
  // An optional `thumbnail` image can be uploaded as the avatar's preview picture.
  .post(
    "/upload",
    async ({ body, session, set }) => {
      // Public avatar upload — same trust gate as world publishing.
      try {
        await requireTrust(session.sub, TRUST_TO_UPLOAD);
      } catch (e) {
        if (e instanceof TrustError) {
          set.status = 403;
          return { error: "insufficient_trust", required: e.required, have: e.have,
                   detail: `Uploading avatars needs trust level ${e.required} (${trustLabel(e.required)}); you are ${e.have} (${trustLabel(e.have)}).` };
        }
        throw e;
      }

      const file = body.file as File;
      if (!file) { set.status = 400; return { error: "missing_file" }; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX_AVATAR_BYTES) { set.status = 413; return { error: "too_large", maxBytes: MAX_AVATAR_BYTES }; }

      // Check if this is a zip file (for PMX + textures)
      const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
                    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);

      let pmxTextureBytes: Map<number, { bytes: Uint8Array; mimeType: string }> | undefined;
      let modelBytes = bytes;

      if (isZip) {
        try {
          const extracted = extractPmxZip(bytes);
          modelBytes = extracted.pmxBytes;
          pmxTextureBytes = extracted.textureBytes;
        } catch (e) {
          set.status = 422;
          return { error: "zip_extraction_failed", detail: e instanceof Error ? e.message : String(e) };
        }
      } else {
        // Decompress gzip-compressed uploads (VRoid Hub serves VRMs gzip-compressed)
        modelBytes = maybeGunzip(bytes);
      }

      const kind = sniffKind(modelBytes, file.name);
      if (kind === "fbx") {
        set.status = 415;
        return { error: "fbx_not_supported", detail: "FBX upload needs conversion to glTF first. Export your rig as VRM or GLB and re-upload." };
      }
      if (kind === "unknown") {
        set.status = 415;
        return { error: "unsupported_format", detail: "Upload a VRM, GLB, PMX, unitypackage, or a zip containing a PMX + textures." };
      }

      let result;
      if (kind === "unitypackage") {
        // Store unitypackage raw asset
        const hash = await sha256Hex(modelBytes);
        const pkgKey = `av/pkg/${hash.slice(0, 2)}/${hash}.unitypackage`;
        await putBytes(pkgKey, modelBytes, "application/octet-stream");

        let thumbnailKey: string | null = null;
        const thumbFile = body.thumbnail as File | undefined;
        if (thumbFile) {
          const thumbBytes = new Uint8Array(await thumbFile.arrayBuffer());
          const thumbHash = await sha256Hex(thumbBytes);
          const thumbExt = (thumbFile.type === "image/jpeg" ? "jpg" : "png");
          thumbnailKey = `av/thumb/${thumbHash.slice(0, 2)}/${thumbHash}.${thumbExt}`;
          await putBytes(thumbnailKey, thumbBytes, thumbFile.type || "image/png");
        }

        const avatar = await prisma.avatar.create({
          data: {
            authorId: session.sub,
            name: body.name || file.name.replace(/\.unitypackage$/i, ""),
            sourceFormat: 5, // unitypackage
            releaseStatus: 0,
            thumbnailKey,
            versions: {
              create: {
                version: 1,
                cdnKey: pkgKey,
                blake3: Buffer.from(hash, "hex"),
                stats: { sizeBytes: modelBytes.length },
              },
            },
          },
          include: withVersion,
        });
        await prisma.avatar.update({
          where: { id: avatar.id },
          data: { publishedVersionId: avatar.versions[0].id },
        });

        return { avatar: serialize(avatar) };
      }

      try {
        result = kind === "pmx"
          ? pmxToSka(modelBytes, { name: body.name }, pmxTextureBytes)
          : vrmOrGlbToSka(modelBytes, { name: body.name });
      } catch (e) {
        set.status = 422;
        return { error: "conversion_failed", detail: e instanceof Error ? e.message : String(e) };
      }

      const hash = await sha256Hex(result.ska);
      const key = skaKeyFor(hash);
      await putBytes(key, result.ska, "application/octet-stream");

      // Thumbnail: prefer user-uploaded thumbnail, then fall back to VRM/GLB embedded thumbnail.
      let thumbnailKey: string | null = null;
      const thumbFile = body.thumbnail as File | undefined;
      if (thumbFile) {
        const thumbBytes = new Uint8Array(await thumbFile.arrayBuffer());
        if (thumbBytes.length > MAX_THUMBNAIL_BYTES) {
          set.status = 413; return { error: "thumbnail_too_large", maxBytes: MAX_THUMBNAIL_BYTES };
        }
        const thumbHash = await sha256Hex(thumbBytes);
        const thumbExt = (thumbFile.type === "image/jpeg" ? "jpg" : "png");
        thumbnailKey = `av/thumb/${thumbHash.slice(0, 2)}/${thumbHash}.${thumbExt}`;
        await putBytes(thumbnailKey, thumbBytes, thumbFile.type || "image/png");
      } else {
        const thumb = extractThumbnail(modelBytes);
        if (thumb) {
          const thumbHash = await sha256Hex(thumb.bytes);
          const ext = thumb.mimeType === "image/jpeg" ? "jpg" : "png";
          thumbnailKey = `av/thumb/${thumbHash.slice(0, 2)}/${thumbHash}.${ext}`;
          await putBytes(thumbnailKey, thumb.bytes, thumb.mimeType);
        }
      }

      const avatar = await prisma.avatar.create({
        data: {
          authorId: session.sub,
          name: result.meta.name,
          sourceFormat: formatCode(result.meta.sourceFormat),
          releaseStatus: 0, // private until the author publishes
          thumbnailKey,
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
    { body: t.Object({ file: t.File(), name: t.Optional(t.String()), thumbnail: t.Optional(t.File()) }) },
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
  )

  // Rename one of the caller's own avatars.
  .post(
    "/:id/rename",
    async ({ params, body, session, set }) => {
      const a = await prisma.avatar.findUnique({ where: { id: params.id } });
      if (!a || a.authorId !== session.sub) { set.status = 404; return { error: "not_found" }; }
      const newName = (body.name ?? "").trim();
      if (!newName) { set.status = 400; return { error: "empty_name" }; }
      if (newName.length > 80) { set.status = 400; return { error: "name_too_long" }; }
      await prisma.avatar.update({ where: { id: params.id }, data: { name: newName } });
      return { ok: true, name: newName };
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ name: t.String() }) },
  )

  // Update thumbnail for one of the caller's own avatars.
  .post(
    "/:id/thumbnail",
    async ({ params, body, session, set }) => {
      const a = await prisma.avatar.findUnique({ where: { id: params.id } });
      if (!a || a.authorId !== session.sub) { set.status = 404; return { error: "not_found" }; }
      const thumbFile = body.thumbnail as File;
      if (!thumbFile) { set.status = 400; return { error: "missing_thumbnail" }; }
      const thumbBytes = new Uint8Array(await thumbFile.arrayBuffer());
      if (thumbBytes.length > MAX_THUMBNAIL_BYTES) { set.status = 413; return { error: "thumbnail_too_large", maxBytes: MAX_THUMBNAIL_BYTES }; }
      const thumbHash = await sha256Hex(thumbBytes);
      const thumbExt = (thumbFile.type === "image/jpeg" ? "jpg" : "png");
      const thumbnailKey = `av/thumb/${thumbHash.slice(0, 2)}/${thumbHash}.${thumbExt}`;
      await putBytes(thumbnailKey, thumbBytes, thumbFile.type || "image/png");
      await prisma.avatar.update({ where: { id: params.id }, data: { thumbnailKey } });
      return { ok: true, thumbnailUrl: imagePublicUrl(thumbnailKey, { w: 512, h: 512 }) };
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ thumbnail: t.File() }) },
  )

  // Delete one of the caller's own avatars (and its stored files).
  .delete(
    "/:id",
    async ({ params, session, set }) => {
      const a = await prisma.avatar.findUnique({ where: { id: params.id }, include: { versions: true } });
      if (!a || a.authorId !== session.sub) { set.status = 404; return { error: "not_found" }; }
      if (a.isBuiltin) { set.status = 403; return { error: "cannot_delete_builtin" }; }
      // Clear currentAvatarId if it points to this avatar
      await prisma.user.updateMany({
        where: { currentAvatarId: params.id },
        data: { currentAvatarId: null },
      });
      await prisma.avatarVersion.deleteMany({ where: { avatarId: params.id } });
      await prisma.avatar.delete({ where: { id: params.id } });
      return { ok: true };
    },
    { params: t.Object({ id: t.String() }) },
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
      const w = await prisma.world.findUnique({ where: { id: params.id }, include: defaultHomeInclude });
      if (!w) { set.status = 404; return { error: "not_found" }; }
      if (!defaultHomeEntry(w, assetPublicUrl)) {
        set.status = 409;
        return { error: "home_requires_public_ready_publication" };
      }
      await prisma.$transaction([
        prisma.world.updateMany({ where: { isDefaultHome: true }, data: { isDefaultHome: false } }),
        prisma.world.update({ where: { id: params.id }, data: { isDefaultHome: true } }),
      ]);
      return { ok: true, defaultHomeId: params.id };
    },
    { params: t.Object({ id: t.String() }) },
  )

  // Grant (or set) a user's trust rank. Writes the new level and an audit row so manual
  // rank changes are durable and reviewable. ModerationAction.kind 4 = trust-grant; the new
  // level is recorded in `reason` alongside the human reason.
  .post(
    "/users/:id/trust",
    async ({ admin, params, body, set }) => {
      const target = await prisma.user.findUnique({
        where: { id: params.id },
        select: { id: true, trustLevel: true },
      });
      if (!target) { set.status = 404; return { error: "not_found" }; }
      if (body.level < 0 || body.level > MAX_TRUST) {
        set.status = 400;
        return { error: "invalid_level", max: MAX_TRUST };
      }

      await prisma.$transaction([
        prisma.user.update({ where: { id: params.id }, data: { trustLevel: body.level } }),
        prisma.moderationAction.create({
          data: {
            actorId: admin.sub,
            targetId: params.id,
            kind: 4,
            reason: `trust ${target.trustLevel}→${body.level}: ${body.reason ?? ""}`.trim(),
          },
        }),
      ]);

      return {
        ok: true,
        userId: params.id,
        trustLevel: body.level,
        trustLabel: trustLabel(body.level),
      };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        level: t.Integer({ minimum: 0, maximum: MAX_TRUST }),
        reason: t.Optional(t.String({ maxLength: 500 })),
      }),
    },
  );
