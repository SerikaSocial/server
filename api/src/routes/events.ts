import { Elysia, t } from "elysia";
import { createHash } from "node:crypto";
import { prisma, redis } from "../db.ts";
import { authed, adminOnly } from "../auth-plugin.ts";
import { assetPublicUrl, putBytes, getObjectBytes } from "../storage.ts";
import { prepareAnimationGlb, inspectGlb, transition, validateShowConfig, showAssetKeys, serializeShowConfig, type ShowConfig } from "../event-config.ts";
import { vrmOrGlbToSka } from "../ska.ts";
import { validateBundle, ReviewStatus } from "../review.ts";
import { audit } from "../audit.ts";
import { worldJoinGate } from "../instance-access.ts";
import { isMaintenance, mintTicket, serializeInstance } from "./instances.ts";
import { place } from "../allocator.ts";

function serialize(e: any, admin = false) {
  const c = e.config as ShowConfig;
  return { id: e.id, worldId: e.worldId, title: e.title, bannerUrl: assetPublicUrl(e.bannerKey),
    status: e.status, revision: e.revision, startedAt: e.startedAt?.getTime() ?? null, serverTime: Date.now(),
    config: serializeShowConfig(c, assetPublicUrl),
    ...(admin ? { bannerKey: e.bannerKey } : {}) };
}
const noCache = ({ set }: any) => { set.headers["Cache-Control"] = "private, no-store"; };
export const eventRoutes = new Elysia({ prefix: "/v1/events" }).use(authed).onBeforeHandle(noCache)
  .get("/", async () => (await prisma.liveEvent.findMany({ where: { status: { in: ["open", "live"] } }, orderBy: { createdAt: "desc" } })).map(e => serialize(e)))
  .get("/:id", async ({ params, set }) => {
    const e = await prisma.liveEvent.findUnique({ where: { id: params.id } });
    if (!e || e.status === "draft") { set.status = 404; return { error: "event_not_found" }; }
    return serialize(e);
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
  .post("/:id/join", async ({ params, session, set }) => {
    if (await isMaintenance(session.sub)) { set.status = 503; return { error: "maintenance" }; }
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM live_events WHERE id = ${params.id}::uuid FOR UPDATE`;
      const event = await tx.liveEvent.findUnique({ where: { id: params.id }, include: { world: true } });
      if (!event || !["open", "live"].includes(event.status)) return { error: "event_closed" };
      const gate = await worldJoinGate(event.world, session.sub, false, true);
      if (gate) return { error: gate };
      const open = await tx.instance.findMany({ where: { eventId: event.id, closedAt: null }, orderBy: { createdAt: "asc" } });
      let chosen = null;
      for (const instance of open) {
        const pendingKey = `event:pending:${instance.id}`;
        await redis.zremrangebyscore(pendingKey, "-inf", Date.now());
        const [live, pending] = await Promise.all([redis.hkeys(`inst:${instance.id}:roster`), redis.zrange(pendingKey, 0, -1)]);
        const users = new Set([...live, ...pending]);
        if (users.has(session.sub) || users.size < instance.capacity) { chosen = instance; break; }
      }
      if (!chosen) {
        const placement = await place({ capacity: event.world.capacity, forceDedicated: true });
        if (!placement) return { error: "no_relay_available" };
        chosen = await tx.instance.create({ data: { worldId: event.worldId, worldVersionId: event.world.publishedVersionId,
          eventId: event.id, ownerId: event.createdBy, access: 0, mode: 1, nodeId: placement.nodeId,
          endpoint: placement.endpoint, capacity: event.world.capacity } });
      }
      await redis.zadd(`event:pending:${chosen.id}`, Date.now() + 60000, session.sub);
      await redis.expire(`event:pending:${chosen.id}`, 90);
      const ticket = await mintTicket(chosen.id, session.sub);
      if (!ticket) return { error: "ticket_failed" };
      return { instance: serializeInstance(chosen), endpoint: chosen.endpoint, worldName: event.world.name, eventId: event.id, ...ticket };
    }, { timeout: 15000 });
    if ("error" in result) set.status = result.error === "no_relay_available" ? 503 : 409;
    return result;
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) });

export const adminEventRoutes = new Elysia({ prefix: "/v1/admin/events" }).use(adminOnly).onBeforeHandle(noCache)
  .get("/", async () => (await prisma.liveEvent.findMany({ orderBy: { createdAt: "desc" } })).map(e => serialize(e, true)))
  .get("/venues", async () => (await prisma.world.findMany({ where: { eventOnly: true, isUnlisted: true }, orderBy: { name: "asc" } })).map(w => ({ id: w.id, name: w.name })))
  .post("/assets/:kind", async ({ body, params, set }) => {
    const file = body.file as File, bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 128 * 1024 * 1024) { set.status = 413; return { error: "File exceeds 128 MB." }; }
    let output: Uint8Array = bytes, filename: string, extra: any = {};
    try {
      switch (params.kind) {
        case "banner":
          if (bytes.length < 24 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") throw new Error("Choose a PNG banner.");
          if (new DataView(bytes.buffer).getUint32(16) > 4096 || new DataView(bytes.buffer).getUint32(20) > 4096 || bytes.length > 8 * 1024 * 1024) throw new Error("Banner must be at most 4096 pixels and 8 MB.");
          filename = "banner.png"; break;
        case "artist": {
          inspectGlb(bytes); const result = vrmOrGlbToSka(bytes, { name: "Event performer" });
          if (!result.meta.humanoid.hips || !result.meta.humanoid.head) throw new Error("Use a humanoid VRM or GLB with recognizable hip and head bones.");
          output = result.ska; filename = "artist.ska"; break;
        }
        case "animation": {
          const prepared = prepareAnimationGlb(bytes);
          output = prepared.bytes; filename = "animation.glb"; extra = { clips: prepared.clips }; break;
        }
        case "intro": {
          if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "OggS" || Buffer.from(bytes.subarray(0, 4096)).indexOf(Buffer.from("theora")) < 0) throw new Error("Convert the intro video to Ogg Theora (.ogv).");
          filename = "intro.ogv"; break;
        }
        case "audio": {
          const ext = file.name.split('.').pop()?.toLowerCase(), magic = new TextDecoder().decode(bytes.subarray(0, 4));
          if (!((ext === "ogg" && magic === "OggS") || (ext === "wav" && magic === "RIFF") || (ext === "mp3" && (magic.startsWith("ID3") || (bytes[0] === 255 && (bytes[1]! & 224) === 224))))) throw new Error("Choose an OGG, WAV or MP3 audio track.");
          filename = `track.${ext}`; break;
        }
        default: throw new Error("Unknown asset type.");
      }
    } catch (e) { set.status = 400; return { error: (e as Error).message }; }
    const hash = createHash("sha256").update(output).digest("hex"), key = `events/${hash}/${filename}`;
    await putBytes(key, output, filename.endsWith("png") ? "image/png" : "application/octet-stream");
    return { key, url: assetPublicUrl(key), ...extra };
  }, { body: t.Object({ file: t.File({ maxSize: "128m" }) }) })
  .post("/venues", async ({ body, session, set }) => {
    const bytes = new Uint8Array(await (body.file as File).arrayBuffer()), report = validateBundle(bytes, 8);
    if (!report.ok || report.hasScript) { set.status = 400; return { error: "Choose a validated static .serikaworld bundle.", detail: report.errors }; }
    const hash = createHash("sha256").update(bytes).digest("hex"), key = `wl/${hash.slice(0, 2)}/${hash}/world.serikaworld`;
    await putBytes(key, bytes, "application/zip");
    const world = await prisma.$transaction(async tx => {
      const w = await tx.world.create({ data: { name: body.name.trim(), authorId: session.sub, isUnlisted: true, eventOnly: true, releaseStatus: 1, forceDedicated: true, capacity: 64 } });
      const v = await tx.worldVersion.create({ data: { worldId: w.id, version: 1, buildStatus: 2, reviewStatus: ReviewStatus.Approved,
        validatorReport: report as any, assets: { create: [0,1,2].map(platform => ({ platform, blake3: Buffer.from(hash, "hex"), bytes: BigInt(bytes.length), cdnKey: key })) } } });
      await tx.world.update({ where: { id: w.id }, data: { publishedVersionId: v.id } }); return w;
    });
    await audit("event.venue_upload", { actorId: session.sub, subjectId: world.id }); return { id: world.id, name: world.name };
  }, { body: t.Object({ file: t.File({ maxSize: "200m" }), name: t.String({ minLength: 1, maxLength: 80 }) }) })
  .post("/", async ({ body, session, set }) => {
    let config: ShowConfig;
    try { config = validateShowConfig(body.config); } catch (e) { set.status = 400; return { error: (e as Error).message }; }
    const world = await prisma.world.findUnique({ where: { id: body.worldId } });
    if (!world?.eventOnly || !world.isUnlisted || await worldJoinGate(world, session.sub, false, true)) { set.status = 400; return { error: "Choose a ready unlisted event venue." }; }
    if (!/^events\/[a-f0-9]{64}\/banner\.png$/.test(body.bannerKey)) { set.status = 400; return { error: "Upload a PNG event banner." }; }
    for (const key of [body.bannerKey, ...showAssetKeys(config)])
      if (!await getObjectBytes(key)) { set.status = 400; return { error: "An uploaded show asset is missing. Upload it again." }; }
    const e = await prisma.liveEvent.create({ data: { worldId: world.id, title: body.title.trim(), bannerKey: body.bannerKey, config: config as any, createdBy: session.sub } });
    await audit("event.create", { actorId: session.sub, subjectId: e.id }); return serialize(e, true);
  }, { body: t.Object({ worldId: t.String({ format: "uuid" }), title: t.String({ minLength: 1, maxLength: 100 }), bannerKey: t.String(), config: t.Unknown() }) })
  .post("/:id/config", async ({ params, body, session, set }) => {
    let config: ShowConfig;
    try { config = validateShowConfig(body.config); } catch (e) { set.status = 400; return { error: (e as Error).message }; }
    const existing = await prisma.liveEvent.findUnique({ where: { id: params.id } });
    if (!existing || !["draft", "ended"].includes(existing.status)) { set.status = 409; return { error: "Close the event before editing its show." }; }
    if (!/^events\/[a-f0-9]{64}\/banner\.png$/.test(body.bannerKey)) { set.status = 400; return { error: "Upload a PNG banner." }; }
    const world = await prisma.world.findUnique({ where: { id: body.worldId } });
    if (!world?.eventOnly || !world.isUnlisted || await worldJoinGate(world, session.sub, false, true)) { set.status = 400; return { error: "Choose a ready event venue." }; }
    for (const key of [body.bannerKey, ...showAssetKeys(config)])
      if (!await getObjectBytes(key)) { set.status = 400; return { error: "An uploaded show asset is missing." }; }
    const updated = await prisma.liveEvent.updateMany({ where: { id: existing.id, revision: existing.revision, status: { in: ["draft", "ended"] } },
      data: { title: body.title.trim(), worldId: body.worldId, bannerKey: body.bannerKey, config: config as any, revision: { increment: 1 } } });
    if (!updated.count) { set.status = 409; return { error: "Event changed; refresh and try again." }; }
    await audit("event.edit", { actorId: session.sub, subjectId: existing.id });
    return serialize(await prisma.liveEvent.findUniqueOrThrow({ where: { id: existing.id } }), true);
  }, { body: t.Object({ worldId: t.String({ format: "uuid" }), title: t.String({ minLength: 1, maxLength: 100 }), bannerKey: t.String(), config: t.Unknown() }) })
  .post("/:id/control", async ({ params, body, session, set }) => {
    const e = await prisma.liveEvent.findUnique({ where: { id: params.id } });
    if (!e) { set.status = 404; return { error: "event_not_found" }; }
    let status: string;
    try { status = transition(e.status, body.action); } catch (err) { set.status = 409; return { error: (err as Error).message }; }
    const changed = await prisma.liveEvent.updateMany({ where: { id: e.id, revision: body.revision }, data: {
      status, revision: { increment: 1 }, startedAt: status === "live" ? new Date(Date.now() + 10000) : null,
    } }).catch((error: any) => { if (error.code === "P2002") return { count: 0 }; throw error; });
    if (changed.count !== 1) { set.status = 409; return { error: "Event changed or another event is open in this venue. Refresh and try again." }; }
    if (status === "ended") {
      const instances = await prisma.instance.findMany({ where: { eventId: e.id, closedAt: null }, select: { id: true } });
      for (const instance of instances) await redis.setex(`inst:${instance.id}:closed`, 300, "1");
      await prisma.instance.updateMany({ where: { eventId: e.id, closedAt: null }, data: { closedAt: new Date() } });
    }
    await audit(`event.${body.action}`, { actorId: session.sub, subjectId: e.id, detail: { revision: body.revision + 1 } });
    return serialize(await prisma.liveEvent.findUniqueOrThrow({ where: { id: e.id } }), true);
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ action: t.Union([t.Literal("open"),t.Literal("play"),t.Literal("stop"),t.Literal("close")]), revision: t.Integer({ minimum: 0 }) }) });
