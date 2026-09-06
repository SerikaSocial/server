import { Elysia, t } from "elysia";
import { unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { prisma, redis } from "../db.ts";
import { assetPublicUrl, putBytes } from "../storage.ts";
import { authed } from "../auth-plugin.ts";
import { sweepStaleInstances } from "./instances.ts";
import { requireTrust, TrustError, TRUST_TO_UPLOAD, trustLabel, Cap, effectiveRank } from "../trust.ts";
import { validateBundle, routeSubmission, ReviewStatus, REVIEW_LABELS, PUBLISHED_STATES } from "../review.ts";
import { audit } from "../audit.ts";
import { defaultHomeEntry, defaultHomeInclude } from "../default-home.ts";

// A world upload is capped well above the largest bundle we ship (~70 MB).
const MAX_WORLD_BYTES = 400 * 1024 * 1024;

export const worldRoutes = new Elysia({ prefix: "/v1/worlds" })
  // Public browse. Ordered by heat; only community/public worlds plus built-ins.
  .get(
    "/",
    async ({ query }) => {
      const take = Math.min(Number(query.limit ?? 50), 100);
      const worlds = await prisma.world.findMany({
        where: { OR: [{ releaseStatus: { gte: 1 } }, { isBuiltin: true }] },
        orderBy: [{ heat: "desc" }, { visitCount: "desc" }],
        take,
        include: {
          author: { select: { username: true } },
          versions: { where: { buildStatus: 2 }, orderBy: { version: "desc" }, take: 1, include: { assets: true } },
        },
      });
      return worlds.map((w) => serializeWorld(w));
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  // The client resolves this at Home entry. An explicit null means use its offline Home;
  // errors remain HTTP errors so it can instead reuse a previously downloaded selection.
  .get("/default-home", async ({ set }) => {
    set.headers["Cache-Control"] = "no-store";
    const world = await prisma.world.findFirst({
      where: { isDefaultHome: true },
      orderBy: { id: "asc" },
      include: defaultHomeInclude,
    });
    return { world: defaultHomeEntry(world, assetPublicUrl) };
  })

  .get("/:id", async ({ params, set }) => {
    const world = await prisma.world.findUnique({
      where: { id: params.id },
      include: {
        author: { select: { username: true } },
        versions: { where: { buildStatus: 2 }, orderBy: { version: "desc" }, take: 1, include: { assets: true } },
      },
    });
    if (!world) {
      set.status = 404;
      return { error: "not_found" };
    }
    // Opportunistically close empty instances before listing.
    await sweepStaleInstances(world.id);

    // Live instance list for this world, straight from the durable table (open instances).
    const instances = await prisma.instance.findMany({
      where: { worldId: world.id, closedAt: null, access: 0 },
      orderBy: { createdAt: "asc" },
    });

    // Fetch live player counts from Redis rosters in parallel.
    const liveCounts = await Promise.all(
      instances.map((i) => redis.hlen(`inst:${i.id}:roster`)),
    );

    return {
      ...serializeWorld(world),
      instances: instances.map((i, idx) => ({
        id: i.id,
        access: i.access,
        mode: i.mode,
        region: i.region,
        playerCount: liveCounts[idx] ?? 0,
        capacity: i.capacity,
      })),
    };
  });

// ── Authenticated: upload a world ─────────────────────────────────────────────────────────

const ZIP_MAGIC = (b: Uint8Array) =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
const GLB_MAGIC = (b: Uint8Array) =>
  b.length > 4 && b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46; // "glTF"

/// Normalise any accepted upload into a `.serikaworld` bundle (zip{world.glb, manifest.json}).
/// Accepts: a ready `.serikaworld`, a raw `.glb`, or a zip that already contains a `.glb`.
/// OBJ/FBX sources must be converted locally first with tools/convert_world.py (Blender).
function toSerikaWorld(bytes: Uint8Array, name: string): Uint8Array {
  const manifest = (spawn = [0, 0, 0]) =>
    new TextEncoder().encode(JSON.stringify({ format: "glb", version: 1, name, spawn, modelFile: "world.glb" }, null, 2));

  if (GLB_MAGIC(bytes)) {
    return zipSync({ "world.glb": [bytes, { level: 0 }], "manifest.json": manifest() });
  }

  if (ZIP_MAGIC(bytes)) {
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    // Already a .serikaworld?
    if (files["world.glb"]) {
      const keep: Record<string, Uint8Array> = { "world.glb": files["world.glb"] };
      keep["manifest.json"] = files["manifest.json"] ?? manifest();
      return zipSync({ "world.glb": [keep["world.glb"], { level: 0 }], "manifest.json": keep["manifest.json"] });
    }
    // A zip that carries a GLB somewhere inside.
    const glbName = names.find((n) => n.toLowerCase().endsWith(".glb"));
    if (glbName) {
      return zipSync({ "world.glb": [files[glbName], { level: 0 }], "manifest.json": manifest() });
    }
    // OBJ/FBX + textures — needs Blender; we can't do that in-process.
    if (names.some((n) => /\.(obj|fbx)$/i.test(n))) {
      throw new Error(
        "obj_fbx_needs_conversion: this zip contains an OBJ/FBX. Convert it to a .serikaworld first with tools/convert_world.py, then upload that.",
      );
    }
    throw new Error("no_glb_in_zip: the zip must contain a .glb (or be a .serikaworld with world.glb).");
  }

  throw new Error("unsupported_format: upload a .serikaworld, a .glb, or a zip containing a .glb.");
}

export const worldUploadRoutes = new Elysia({ prefix: "/v1/worlds" })
  .use(authed)
  // List worlds I authored.
  .get("/mine/list", async ({ session }) => {
    const worlds = await prisma.world.findMany({
      where: { authorId: session.sub },
      orderBy: { createdAt: "desc" },
      include: {
        author: { select: { username: true } },
        versions: { where: { buildStatus: 2 }, orderBy: { version: "desc" }, take: 1, include: { assets: true } },
      },
    });
    return { worlds: worlds.map(serializeWorld) };
  })
  // Upload a world bundle (multipart `file`). Creates a *submission* — never a self-published
  // public world. Where it lands depends on the author's trust rank and whether the bundle
  // contains script/executable content (see review.ts routeSubmission).
  .post(
    "/upload",
    async ({ body, session, set }) => {
      // Everyone who submits needs at least the static-world floor.
      try {
        await requireTrust(session.sub, Cap.SubmitStaticWorld);
      } catch (e) {
        if (e instanceof TrustError) {
          set.status = 403;
          return { error: "insufficient_trust", required: e.required, have: e.have,
                   detail: `Submitting worlds needs trust ${e.required} (${trustLabel(e.required)}); you are ${e.have} (${trustLabel(e.have)}).` };
        }
        throw e;
      }

      const file = body.file as File;
      if (!file) { set.status = 400; return { error: "missing_file" }; }
      const raw = new Uint8Array(await file.arrayBuffer());
      if (raw.length > MAX_WORLD_BYTES) { set.status = 413; return { error: "too_large", maxBytes: MAX_WORLD_BYTES }; }

      const name = (body.name?.trim() || file.name.replace(/\.[^.]+$/, "") || "Untitled World").slice(0, 80);

      let bundle: Uint8Array;
      try {
        bundle = toSerikaWorld(raw, name);
      } catch (e) {
        set.status = 415;
        const msg = e instanceof Error ? e.message : String(e);
        return { error: msg.split(":")[0], detail: msg };
      }

      // Automated validation + routing.
      const [rank, caller] = await Promise.all([
        effectiveRank(session.sub),
        prisma.user.findUnique({ where: { id: session.sub }, select: { isAdmin: true } }),
      ]);
      const report = validateBundle(bundle, rank);

      // Scripted content requires the scripted-submit rank to even enter the pipeline.
      if (report.hasScript && !caller?.isAdmin && rank < Cap.SubmitScriptedWorld) {
        set.status = 403;
        return {
          error: "insufficient_trust", required: Cap.SubmitScriptedWorld, have: rank,
          detail: `This world contains script; submitting scripted worlds needs trust ${Cap.SubmitScriptedWorld} (${trustLabel(Cap.SubmitScriptedWorld)}).`,
        };
      }

      const decision = routeSubmission(rank, report, !!caller?.isAdmin);
      const published = PUBLISHED_STATES.has(decision.reviewStatus);

      const hash = createHash("sha256").update(bundle).digest("hex");
      const key = `wl/${hash.slice(0, 2)}/${hash}/world.serikaworld`;
      await putBytes(key, bundle, "application/zip");
      const blake3 = Buffer.from(hash, "hex");

      const world = await prisma.world.create({
        data: {
          authorId: session.sub,
          name,
          description: (body.description ?? "").slice(0, 2000),
          tags: (body.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12),
          // Only becomes public once a version is published; otherwise stays private (0).
          releaseStatus: published ? 2 : 0,
          isBuiltin: false,
          versions: {
            create: {
              version: 1,
              buildStatus: 2, // ready (asset is already a finished bundle)
              reviewStatus: decision.reviewStatus,
              hasScript: decision.hasScript,
              validatorReport: report as any,
              assets: { create: [0, 1, 2].map((platform) => ({ platform, blake3, bytes: BigInt(bundle.length), cdnKey: key })) },
            },
          },
        },
        include: {
          author: { select: { username: true } },
          versions: { orderBy: { version: "desc" }, take: 1, include: { assets: true } },
        },
      });
      const version = world.versions[0];

      if (published) {
        await prisma.world.update({ where: { id: world.id }, data: { publishedVersionId: version.id } });
        if (decision.selfPublishScripted) {
          // Top-rank scripted self-publish: record a self-review row + audit, land in spot-audit.
          await prisma.worldReview.create({
            data: { worldVersionId: version.id, reviewerId: session.sub, decision: 0, notes: "top-rank self-publish", selfPublish: true },
          });
          await audit("world.self_publish", { actorId: session.sub, subjectId: version.id, detail: { rank, name } });
        } else {
          await audit("world.publish", { actorId: session.sub, subjectId: version.id, detail: { rank, name, auto: true } });
        }
      }

      return {
        submissionId: version.id,
        worldId: world.id,
        reviewStatus: decision.reviewStatus,
        reviewStatusLabel: REVIEW_LABELS[decision.reviewStatus],
        hasScript: decision.hasScript,
        published,
        validator: { ok: report.ok, errors: report.errors, warnings: report.warnings, bundleBytes: report.bundleBytes, budgetBytes: report.budgetBytes },
        world: published ? serializeWorld(world) : undefined,
      };
    },
    {
      body: t.Object({
        file: t.File(),
        name: t.Optional(t.String()),
        description: t.Optional(t.String()),
        tags: t.Optional(t.String()),
      }),
    },
  );

function serializeWorld(w: any) {
  const latestVersion = w.versions?.[0];
  const platformAsset = latestVersion?.assets?.find((a: any) =>
    a.platform === (process.platform === "win32" ? 0 : process.platform === "linux" ? 1 : 2)
  ) ?? latestVersion?.assets?.[0];
  return {
    id: w.id,
    name: w.name,
    description: w.description,
    tags: w.tags,
    capacity: w.capacity,
    releaseStatus: w.releaseStatus,
    isBuiltin: w.isBuiltin,
    visitCount: Number(w.visitCount),
    heat: w.heat,
    author: w.author?.username ?? null,
    downloadUrl: platformAsset?.cdnKey ? assetPublicUrl(platformAsset.cdnKey) : null,
    thumbnailUrl: null,
  };
}
