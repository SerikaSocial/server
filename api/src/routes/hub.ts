import { createHash } from "node:crypto";
import { Elysia, t } from "elysia";
import { prisma } from "../db.ts";
import { assetPublicUrl, putBytes } from "../storage.ts";
import { authed, adminOnly } from "../auth-plugin.ts";
import { config } from "../config.ts";

// The Serika Desktop Hub backend: news, the app catalogue with releases, and the
// per-user surfaces the Hub's Home tab renders (recent worlds, favourites, Serika+).
//
// The catalogue is deliberately generic — HubApp/HubRelease rows describe every Serika
// desktop app, Serika Social included, so "update me" is one code path in the Hub, not a
// per-app special case. Publishing rows is an admin job (the web admin pages do it);
// publish-release.ts will POST a HubRelease row per platform as releases ship.

const HUB_PLATFORMS = [
  "windows-x86_64",
  "linux-x86_64",
  "macos-universal",
  "android-quest-arm64",
  "android-mobile-arm64",
] as const;

const HUB_CHANNELS = ["stable", "beta", "nightly"] as const;

// A desktop build can be large (the Windows client ships at ~325 MB); the body limit in
// index.ts is raised to match. Cap the STORED size below it so a bad request fails cleanly.
const MAX_HUB_BUILD_BYTES = 500 * 1024 * 1024;

// Elysia 1.1 has no t.UnionEnum; t.Union of literals validates the same set.
const channelSchema = t.Union(HUB_CHANNELS.map((c) => t.Literal(c)));
const platformSchema = t.Union(HUB_PLATFORMS.map((p) => t.Literal(p)));

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `post-${Date.now()}`;

/// Public news + catalogue. Unauthenticated reads: the Hub shows Home and the store
/// before anyone logs in, and none of this is per-user.
export const hubRoutes = new Elysia({ prefix: "/v1/hub" })
  .get(
    "/news",
    async ({ query }) => {
      const take = Math.min(Number(query.limit ?? 20), 50);
      const posts = await prisma.newsPost.findMany({
        where: { publishedAt: { not: null } },
        orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }],
        take,
        include: { app: { select: { slug: true, name: true } } },
      });
      return {
        posts: posts.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          body: p.body,
          imageUrl: p.imageKey ? assetPublicUrl(p.imageKey) : null,
          pinned: p.pinned,
          publishedAt: p.publishedAt,
          app: p.app ?? undefined,
        })),
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  .get(
    "/apps",
    async ({ query }) => {
      const take = Math.min(Number(query.limit ?? 50), 100);
      const apps = await prisma.hubApp.findMany({
        where: { visible: true },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
        take,
        include: {
          releases: {
            where: {
              channel: query.channel ?? "stable",
              ...(query.platform ? { platform: query.platform } : {}),
            },
            orderBy: { publishedAt: "desc" },
            take: 1,
          },
        },
      });
      return {
        apps: apps.map((a) => {
          const r = a.releases[0];
          return {
            id: a.id,
            slug: a.slug,
            name: a.name,
            blurb: a.blurb,
            iconUrl: a.iconKey ? assetPublicUrl(a.iconKey) : null,
            kind: a.kind,
            homepage: a.homepage,
            latestRelease: r
              ? {
                  version: r.version,
                  channel: r.channel,
                  platform: r.platform,
                  url: r.url,
                  sha256: r.sha256,
                  sizeBytes: Number(r.sizeBytes),
                  notes: r.notes,
                  publishedAt: r.publishedAt,
                }
              : null,
          };
        }),
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        channel: t.Optional(channelSchema),
        platform: t.Optional(platformSchema),
      }),
    },
  )

  .get(
    "/apps/:slug/releases",
    async ({ params, query, set }) => {
      const app = await prisma.hubApp.findUnique({ where: { slug: params.slug } });
      if (!app || !app.visible) {
        set.status = 404;
        return { error: "not_found" };
      }
      const releases = await prisma.hubRelease.findMany({
        where: {
          appId: app.id,
          channel: query_channel(query.channel),
          ...(query_platform(query.platform) ? { platform: query_platform(query.platform)! } : {}),
        },
        orderBy: { publishedAt: "desc" },
        take: 50,
      });
      return {
        releases: releases.map((r) => ({
          id: r.id,
          version: r.version,
          channel: r.channel,
          platform: r.platform,
          url: r.url,
          sha256: r.sha256,
          sizeBytes: Number(r.sizeBytes),
          notes: r.notes,
          publishedAt: r.publishedAt,
        })),
      };
    },
    {
      params: t.Object({ slug: t.String() }),
      query: t.Object({
        channel: t.Optional(t.String()),
        platform: t.Optional(t.String()),
      }),
    },
  );

// Release channel/platform filters accept unknown strings (→ undefined) rather than
// failing the request — a Hub built against a newer platform list must still list releases.
const query_channel = (c?: string) => (HUB_CHANNELS as readonly string[]).includes(c ?? "") ? c : "stable";
const query_platform = (p?: string) => ((HUB_PLATFORMS as readonly string[]).includes(p ?? "") ? p : undefined);

/// Per-user Hub surfaces.
export const hubMeRoutes = new Elysia({ prefix: "/v1/hub/me" })
  .use(authed)
  .get("/recent-worlds", async ({ session }) => {
    const visits = await prisma.userWorldVisit.findMany({
      where: { userId: session.sub },
      orderBy: { visitedAt: "desc" },
      take: 50,
    });
    const worlds = await prisma.world.findMany({
      where: { id: { in: visits.map((v) => v.worldId) } },
      select: { id: true, name: true, isUnlisted: true, releaseStatus: true, isBuiltin: true },
    });
    const byId = new Map(worlds.map((w) => [w.id, w]));
    return {
      visits: visits
        .map((v) => {
          const w = byId.get(v.worldId);
          return w
            ? { worldId: v.worldId, worldName: w.name, visitedAt: v.visitedAt }
            : { worldId: v.worldId, worldName: null, visitedAt: v.visitedAt };
        })
        .filter((v) => v.worldName !== null),
    };
  })

  .get("/favorites", async ({ session, query }) => {
    const kind = query.kind === "avatar" ? 1 : query.kind === "user" ? 2 : 0;
    const favorites = await prisma.favorite.findMany({
      where: { userId: session.sub, kind },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // World favourites resolve their names; avatar/user kinds return bare targets — the
    // avatar catalogue route owns avatar rendering, and users may want to self-resolve.
    if (kind !== 0) {
      return { favorites: favorites.map((f) => ({ targetId: f.targetId, kind, createdAt: f.createdAt })) };
    }
    const worlds = await prisma.world.findMany({
      where: { id: { in: favorites.map((f) => f.targetId) } },
      select: { id: true, name: true },
    });
    const byId = new Map(worlds.map((w) => [w.id, w]));
    return {
      favorites: favorites.map((f) => ({
        targetId: f.targetId,
        kind,
        worldName: byId.get(f.targetId)?.name ?? null,
        createdAt: f.createdAt,
      })),
    };
  }, {
    query: t.Object({ kind: t.Optional(t.String()) }),
  })

  // Serika+ status for the Hub's store tab. The users mirror here is the fast read;
  // checkout and the billing portal are pages ON serika-accounts (its Stripe flow lives
  // there), so the Hub just opens them.
  .get("/plus", async ({ session }) => {
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { isPremium: true },
    });
    return {
      isPremium: !!user?.isPremium,
      checkoutUrl: `${config.accounts.baseUrl}/premium`,
      portalUrl: `${config.accounts.baseUrl}/account`,
    };
  });

// ── Admin: publish news, catalogue apps, cut releases ────────────────────────────────────

const newsBody = t.Object({
  title: t.String({ minLength: 1, maxLength: 200 }),
  body: t.String({ maxLength: 100_000 }),
  slug: t.Optional(t.String()),
  imageKey: t.Optional(t.String()),
  appId: t.Optional(t.String()),
  pinned: t.Optional(t.Boolean()),
  publish: t.Optional(t.Boolean()),
});

// PATCH accepts a partial body: one-word unpublish (`{"publish":false}`) is the common case.
const newsPatchBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  body: t.Optional(t.String({ maxLength: 100_000 })),
  slug: t.Optional(t.String()),
  imageKey: t.Optional(t.String()),
  appId: t.Optional(t.String()),
  pinned: t.Optional(t.Boolean()),
  publish: t.Optional(t.Boolean()),
});

export const hubAdminRoutes = new Elysia({ prefix: "/v1/admin/hub" })
  .use(adminOnly)

  // Admin lists see drafts and hidden apps; the public routes only see published/visible.
  .get("/news", async () => {
    const posts = await prisma.newsPost.findMany({
      orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: { app: { select: { slug: true, name: true } } },
    });
    return { posts };
  })
  .get("/apps", async () => {
    const apps = await prisma.hubApp.findMany({
      orderBy: [{ kind: "asc" }, { name: "asc" }],
      include: { releases: { orderBy: { publishedAt: "desc" } } },
    });
    // Map explicitly: sizeBytes is a Prisma BigInt and Bun's JSON.stringify THROWS on
    // BigInt — the first release published made this whole endpoint 500 (the admin panel
    // then showed an empty catalogue while the Hub kept working off the mapped routes).
    return {
      apps: apps.map((a) => ({
        ...a,
        releases: a.releases.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) })),
      })),
    };
  })

  // ── News ─────────────────────────────────────────────────────────────────
  .post(
    "/news",
    async ({ body, session }) => {
      const post = await prisma.newsPost.create({
        data: {
          slug: body.slug ? slugify(body.slug) : slugify(body.title),
          title: body.title,
          body: body.body,
          imageKey: body.imageKey,
          appId: body.appId,
          pinned: body.pinned ?? false,
          publishedAt: body.publish ? new Date() : null,
          authorId: session.sub,
        },
      });
      return { id: post.id, slug: post.slug };
    },
    { body: newsBody },
  )
  .patch(
    "/news/:id",
    async ({ params, body, set }) => {
      const existing = await prisma.newsPost.findUnique({ where: { id: params.id } });
      if (!existing) { set.status = 404; return { error: "not_found" }; }
      const post = await prisma.newsPost.update({
        where: { id: params.id },
        data: {
          title: body.title ?? undefined,
          body: body.body ?? undefined,
          imageKey: body.imageKey ?? undefined,
          appId: body.appId ?? undefined,
          pinned: body.pinned ?? undefined,
          // publish:true stamps the timestamp on a draft; publish:false unpublishes.
          ...(body.publish !== undefined ? { publishedAt: body.publish ? (existing.publishedAt ?? new Date()) : null } : {}),
        },
      });
      return { id: post.id, slug: post.slug, publishedAt: post.publishedAt };
    },
    { params: t.Object({ id: t.String({ format: "uuid" }) }), body: newsPatchBody },
  )
  .delete("/news/:id", async ({ params }) => {
    await prisma.newsPost.delete({ where: { id: params.id } });
    return { ok: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })

  // ── Apps ─────────────────────────────────────────────────────────────────
  .post(
    "/apps",
    async ({ body }) => {
      const app = await prisma.hubApp.create({
        data: {
          slug: body.slug ? slugify(body.slug) : slugify(body.name),
          name: body.name,
          blurb: body.blurb ?? "",
          iconKey: body.iconKey,
          kind: body.kind === "game" ? "game" : "app",
          homepage: body.homepage,
          visible: body.visible ?? false,
        },
      });
      return { id: app.id, slug: app.slug };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 120 }),
        slug: t.Optional(t.String()),
        blurb: t.Optional(t.String({ maxLength: 2000 })),
        iconKey: t.Optional(t.String()),
        kind: t.Optional(t.String()),
        homepage: t.Optional(t.String()),
        visible: t.Optional(t.Boolean()),
      }),
    },
  )
  .patch(
    "/apps/:id",
    async ({ params, body, set }) => {
      const existing = await prisma.hubApp.findUnique({ where: { id: params.id } });
      if (!existing) { set.status = 404; return { error: "not_found" }; }
      const app = await prisma.hubApp.update({
        where: { id: params.id },
        data: {
          name: body.name ?? undefined,
          blurb: body.blurb ?? undefined,
          iconKey: body.iconKey ?? undefined,
          kind: body.kind === "game" ? "game" : body.kind === "app" ? "app" : undefined,
          homepage: body.homepage ?? undefined,
          visible: body.visible ?? undefined,
        },
      });
      return { id: app.id, slug: app.slug, visible: app.visible };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
        blurb: t.Optional(t.String({ maxLength: 2000 })),
        iconKey: t.Optional(t.String()),
        kind: t.Optional(t.String()),
        homepage: t.Optional(t.String()),
        visible: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete("/apps/:id", async ({ params }) => {
    await prisma.hubApp.delete({ where: { id: params.id } });
    return { ok: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })

  // ── Releases ─────────────────────────────────────────────────────────────
  .post(
    "/apps/:id/releases",
    async ({ params, body, set }) => {
      const app = await prisma.hubApp.findUnique({ where: { id: params.id }, select: { id: true } });
      if (!app) { set.status = 404; return { error: "app_not_found" }; }
      const release = await prisma.hubRelease.upsert({
        where: { appId_channel_platform_version: {
          appId: app.id, channel: body.channel, platform: body.platform, version: body.version,
        } },
        create: {
          appId: app.id,
          version: body.version,
          channel: body.channel,
          platform: body.platform,
          url: body.url,
          sha256: body.sha256.toLowerCase(),
          sizeBytes: BigInt(body.sizeBytes ?? 0),
          notes: body.notes ?? "",
        },
        update: {
          url: body.url,
          sha256: body.sha256.toLowerCase(),
          sizeBytes: BigInt(body.sizeBytes ?? 0),
          notes: body.notes ?? "",
        },
      });
      return { id: release.id };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        version: t.String({ minLength: 1, maxLength: 40 }),
        channel: channelSchema,
        platform: platformSchema,
        url: t.String(),
        sha256: t.String({ minLength: 64, maxLength: 64 }),
        sizeBytes: t.Optional(t.Numeric()),
        notes: t.Optional(t.String({ maxLength: 20_000 })),
      }),
    },
  )
  .delete("/releases/:id", async ({ params }) => {
    await prisma.hubRelease.delete({ where: { id: params.id } });
    return { ok: true };
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })

  // Upload a build FILE for a release. This is the path for publishing Serika Moe or any
  // third desktop app without shell access: pick the file in the admin pages and the API
  // stores it on B2, hashes it and upserts the release row in one step. Externally-hosted
  // builds keep using POST /apps/:id/releases with an explicit url + sha256.
  .post(
    "/apps/:id/releases/upload",
    async ({ params, body, set }) => {
      const app = await prisma.hubApp.findUnique({ where: { id: params.id }, select: { id: true, slug: true } });
      if (!app) { set.status = 404; return { error: "app_not_found" }; }

      const file = body.file as File;
      if (!file || file.size === 0) { set.status = 400; return { error: "missing_file" }; }
      if (file.size > MAX_HUB_BUILD_BYTES) {
        set.status = 413;
        return { error: "too_large", maxBytes: MAX_HUB_BUILD_BYTES };
      }
      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "build.bin";

      const bytes = new Uint8Array(await file.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = `hub/${app.slug}/${body.version}/${body.platform}/${safeName}`;
      await putBytes(key, bytes, "application/octet-stream");

      const release = await prisma.hubRelease.upsert({
        where: { appId_channel_platform_version: {
          appId: app.id, channel: body.channel, platform: body.platform, version: body.version,
        } },
        create: {
          appId: app.id,
          version: body.version,
          channel: body.channel,
          platform: body.platform,
          url: assetPublicUrl(key),
          sha256,
          sizeBytes: BigInt(bytes.length),
          notes: body.notes ?? "",
        },
        update: {
          url: assetPublicUrl(key),
          sha256,
          sizeBytes: BigInt(bytes.length),
          notes: body.notes ?? "",
        },
      });
      return { id: release.id, url: release.url, sha256, sizeBytes: bytes.length };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        file: t.File(),
        version: t.String({ minLength: 1, maxLength: 40 }),
        channel: channelSchema,
        platform: platformSchema,
        notes: t.Optional(t.String({ maxLength: 20_000 })),
      }),
    },
  );

/// Called from the instance-join paths. Fire-and-forget: a history write must never
/// delay or fail a join. Keeps the newest 50 distinct worlds per user.
export async function recordWorldVisit(userId: string, worldId: string): Promise<void> {
  try {
    await prisma.userWorldVisit.upsert({
      where: { userId_worldId: { userId, worldId } },
      create: { userId, worldId },
      update: { visitedAt: new Date() },
    });
    const keep = await prisma.userWorldVisit.findMany({
      where: { userId },
      orderBy: { visitedAt: "desc" },
      take: 50,
      select: { worldId: true },
    });
    if (keep.length === 50) {
      await prisma.userWorldVisit.deleteMany({
        where: { userId, worldId: { notIn: keep.map((k) => k.worldId) } },
      });
    }
  } catch (e) {
    console.error("hub: visit record failed:", e);
  }
}
