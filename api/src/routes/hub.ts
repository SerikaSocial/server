import { createHash, randomUUID } from "node:crypto";
import { Elysia, t } from "elysia";
import { prisma } from "../db.ts";
import { assetPublicUrl, putBytes, presignPut, storageConfigured } from "../storage.ts";
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
  "windows-arm64",
  "linux-x86_64",
  "linux-arm64",
  "macos-universal",
  "macos-arm64",
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
        include: {
          app: { select: { slug: true, name: true } },
          author: { select: { username: true, avatarUrl: true } },
          _count: { select: { comments: true } },
        },
      });
      return {
        posts: posts.map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          // The list carries a teaser; the article view fetches the full body.
          body: p.body.slice(0, 400),
          imageUrl: p.imageKey ? assetPublicUrl(p.imageKey) : null,
          pinned: p.pinned,
          publishedAt: p.publishedAt,
          author: p.author ? { username: p.author.username, avatarUrl: p.author.avatarUrl } : null,
          commentsCount: p._count.comments,
          app: p.app ?? undefined,
        })),
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }) },
  )

  // The article view: one post, full body, author.
  .get(
    "/news/:slug",
    async ({ params, set }) => {
      const post = await prisma.newsPost.findUnique({
        where: { slug: params.slug },
        include: {
          app: { select: { slug: true, name: true } },
          author: { select: { username: true, avatarUrl: true } },
        },
      });
      if (!post || !post.publishedAt || post.publishedAt > new Date()) {
        set.status = 404;
        return { error: "not_found" };
      }
      return {
        post: {
          id: post.id,
          slug: post.slug,
          title: post.title,
          body: post.body,
          imageUrl: post.imageKey ? assetPublicUrl(post.imageKey) : null,
          pinned: post.pinned,
          publishedAt: post.publishedAt,
          author: post.author ? { username: post.author.username, avatarUrl: post.author.avatarUrl } : null,
          app: post.app ?? undefined,
        },
      };
    },
    { params: t.Object({ slug: t.String() }) },
  )

  // Comments under an article. Public read; authed write below.
  .get(
    "/news/:slug/comments",
    async ({ params }) => {
      const post = await prisma.newsPost.findUnique({ where: { slug: params.slug }, select: { id: true } });
      if (!post) return { comments: [] };
      const rows = await prisma.newsComment.findMany({
        where: { postId: post.id },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { user: { select: { username: true, avatarUrl: true, isPremium: true } } },
      });
      return {
        comments: rows.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
          author: { username: c.user.username, avatarUrl: c.user.avatarUrl, isPremium: c.user.isPremium },
        })),
      };
    },
    { params: t.Object({ slug: t.String() }) },
  )

  .get(
    "/apps",
    async ({ query }) => {
      const take = Math.min(Number(query.limit ?? 50), 100);
      const apps = await prisma.hubApp.findMany({
        where: { visible: true },
        // sortOrder is the editorial hand: it decides what leads the Hub's Discover
        // spotlight. Kind/name only break ties.
        orderBy: [{ sortOrder: "asc" }, { kind: "asc" }, { name: "asc" }],
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
            tagline: a.tagline,
            iconUrl: a.iconKey ? assetPublicUrl(a.iconKey) : null,
            // The card art. Null means the app has no cover yet — clients must render
            // an honest empty state rather than inventing placeholder graphics.
            coverUrl: a.coverKey ? assetPublicUrl(a.coverKey) : null,
            developer: a.developer,
            tags: a.tags,
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

  // The store page: everything the catalogue list omits, plus the newest release per
  // platform so a client can show "available on" without a request per platform.
  .get(
    "/apps/:slug",
    async ({ params, query, set }) => {
      const app = await prisma.hubApp.findUnique({
        where: { slug: params.slug },
        include: {
          releases: {
            where: { channel: query.channel ?? "stable" },
            orderBy: { publishedAt: "desc" },
            take: 100,
          },
          news: {
            where: { publishedAt: { not: null } },
            orderBy: { publishedAt: "desc" },
            take: 5,
            select: { slug: true, title: true, publishedAt: true, imageKey: true },
          },
        },
      });
      if (!app || !app.visible) {
        set.status = 404;
        return { error: "not_found" };
      }
      // Newest release per platform. The list is already newest-first, so the first
      // sighting of a platform wins.
      const perPlatform = new Map<string, (typeof app.releases)[number]>();
      for (const r of app.releases) if (!perPlatform.has(r.platform)) perPlatform.set(r.platform, r);

      return {
        app: {
          id: app.id,
          slug: app.slug,
          name: app.name,
          blurb: app.blurb,
          tagline: app.tagline,
          description: app.description,
          developer: app.developer,
          publisher: app.publisher,
          kind: app.kind,
          tags: app.tags,
          iconUrl: app.iconKey ? assetPublicUrl(app.iconKey) : null,
          coverUrl: app.coverKey ? assetPublicUrl(app.coverKey) : null,
          screenshots: app.screenshots.map((key) => assetPublicUrl(key)),
          homepage: app.homepage,
          supportUrl: app.supportUrl,
          sourceUrl: app.sourceUrl,
          trailerUrl: app.trailerUrl,
          releases: [...perPlatform.values()].map((r) => ({
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
          news: app.news.map((n) => ({
            slug: n.slug,
            title: n.title,
            publishedAt: n.publishedAt,
            imageUrl: n.imageKey ? assetPublicUrl(n.imageKey) : null,
          })),
        },
      };
    },
    { params: t.Object({ slug: t.String() }), query: t.Object({ channel: t.Optional(channelSchema) }) },
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
  )

  .get("/feed/art", async () => {
    try {
      const res = await fetch("https://serika.art/api/images?limit=24&ratings=safe&sort=popular", {
        headers: { "User-Agent": "SerikaHub/0.1" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { items: [] };
      const data = await res.json() as { images?: Array<Record<string, unknown>> };
      const items = (data.images ?? [])
        .filter((img) => String(img.rating ?? "safe") === "safe")
        .map((img) => ({
          id: String(img.id ?? ""),
          title: String((img as { username?: string }).username ?? "serika.art"),
          thumbUrl: String(img.thumbnail_url ?? img.thumbnailUrl ?? img.url ?? ""),
          url: `https://serika.art/image/${img.id}`,
          source: "art",
        }));
      return { items };
    } catch {
      return { items: [] };
    }
  })

  .get("/feed/gifs", async () => {
    try {
      const res = await fetch("https://gifs.serika.dev/api/gifs?limit=24", {
        headers: { "User-Agent": "SerikaHub/0.1" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { items: [] };
      const data = await res.json() as { gifs?: Array<Record<string, unknown>> };
      const items = (data.gifs ?? [])
        .filter((g) => !g.isNsfw)
        .map((g) => ({
          id: String(g.id ?? ""),
          title: String(g.title ?? g.slug ?? "GIF"),
          thumbUrl: String(g.thumbnailUrl ?? g.url ?? ""),
          url: `https://gifs.serika.dev/gif/${g.slug ?? g.id}`,
          source: "gifs",
        }));
      return { items };
    } catch {
      return { items: [] };
    }
  });

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

/// Store-page fields shared by app create and patch.
const appContentFields = {
  blurb: t.Optional(t.String({ maxLength: 2000 })),
  tagline: t.Optional(t.String({ maxLength: 300 })),
  description: t.Optional(t.String({ maxLength: 100_000 })),
  developer: t.Optional(t.String({ maxLength: 200 })),
  publisher: t.Optional(t.String({ maxLength: 200 })),
  tags: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 20 })),
  screenshots: t.Optional(t.Array(t.String({ maxLength: 500 }), { maxItems: 12 })),
  iconKey: t.Optional(t.String({ maxLength: 500 })),
  coverKey: t.Optional(t.String({ maxLength: 500 })),
  kind: t.Optional(t.String()),
  homepage: t.Optional(t.String({ maxLength: 500 })),
  supportUrl: t.Optional(t.String({ maxLength: 500 })),
  sourceUrl: t.Optional(t.String({ maxLength: 500 })),
  trailerUrl: t.Optional(t.String({ maxLength: 500 })),
  sortOrder: t.Optional(t.Integer({ minimum: -1000, maximum: 1000 })),
  githubRepo: t.Optional(t.String({ maxLength: 200 })),
  visible: t.Optional(t.Boolean()),
};

const appCreateBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  slug: t.Optional(t.String()),
  ...appContentFields,
});

const appPatchBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  slug: t.Optional(t.String()),
  ...appContentFields,
});

/// Prisma treats `undefined` as "leave alone" and `null` as "write NULL", but a JSON body
/// cannot express "leave alone" other than by omission. Absent → skip; empty string →
/// clear to NULL; anything else → write it. Without this an admin can set a wrong icon or
/// homepage and then has no way to remove it.
function clearable<K extends string>(key: K, value: string | undefined) {
  if (value === undefined) return {};
  return { [key]: value.trim() === "" ? null : value.trim() } as Record<K, string | null>;
}

export const hubAdminRoutes = new Elysia({ prefix: "/v1/admin/hub" })
  .use(adminOnly)

  // Admin lists see drafts and hidden apps; the public routes only see published/visible.
  .get("/news", async () => {
    const posts = await prisma.newsPost.findMany({
      orderBy: [{ pinned: "desc" }, { publishedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        app: { select: { slug: true, name: true } },
        author: { select: { username: true } },
      },
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
          pinned: body.pinned ?? undefined,
          ...clearable("imageKey", body.imageKey),
          ...(body.appId === undefined ? {} : { appId: body.appId.trim() === "" ? null : body.appId }),
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
          tagline: body.tagline ?? "",
          description: body.description ?? "",
          developer: body.developer ?? "",
          publisher: body.publisher ?? "",
          tags: body.tags ?? [],
          screenshots: body.screenshots ?? [],
          iconKey: body.iconKey,
          coverKey: body.coverKey,
          kind: body.kind === "game" ? "game" : "app",
          homepage: body.homepage,
          supportUrl: body.supportUrl,
          sourceUrl: body.sourceUrl,
          trailerUrl: body.trailerUrl,
          sortOrder: body.sortOrder ?? 0,
          githubRepo: body.githubRepo,
          visible: body.visible ?? false,
        },
      });
      return { id: app.id, slug: app.slug };
    },
    { body: appCreateBody },
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
          slug: body.slug ? slugify(body.slug) : undefined,
          blurb: body.blurb ?? undefined,
          tagline: body.tagline ?? undefined,
          description: body.description ?? undefined,
          developer: body.developer ?? undefined,
          publisher: body.publisher ?? undefined,
          tags: body.tags ?? undefined,
          screenshots: body.screenshots ?? undefined,
          sortOrder: body.sortOrder ?? undefined,
          kind: body.kind === "game" ? "game" : body.kind === "app" ? "app" : undefined,
          visible: body.visible ?? undefined,
          // Nullable fields take "" as "clear this". `?? undefined` alone means an admin
          // can set a wrong homepage or a bad icon and then never remove it — the field
          // is only ever writable to another non-empty value.
          ...clearable("iconKey", body.iconKey),
          ...clearable("coverKey", body.coverKey),
          ...clearable("homepage", body.homepage),
          ...clearable("supportUrl", body.supportUrl),
          ...clearable("sourceUrl", body.sourceUrl),
          ...clearable("trailerUrl", body.trailerUrl),
          ...clearable("githubRepo", body.githubRepo),
        },
      });
      return { id: app.id, slug: app.slug, visible: app.visible };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: appPatchBody,
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
          sha256: (body.sha256 ?? "").toLowerCase(),
          sizeBytes: BigInt(body.sizeBytes ?? 0),
          notes: body.notes ?? "",
        },
        update: {
          url: body.url,
          sha256: (body.sha256 ?? "").toLowerCase(),
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
        // Externally-hosted builds (GitHub releases and friends) may not publish a hash —
        // an absent sha256 simply skips the Hub's download verification.
        sha256: t.Optional(t.String({ minLength: 64, maxLength: 64 })),
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
  )

  // News cover image: multipart, stored on B2 under news/. Returns the key for the post.
  .post(
    "/news-image",
    async ({ body, set }) => {
      const file = body.file as File;
      if (!file || file.size === 0) { set.status = 400; return { error: "missing_file" }; }
      if (file.size > 20 * 1024 * 1024) { set.status = 413; return { error: "too_large", maxBytes: 20 * 1024 * 1024 }; }
      const ext = (file.name.match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "png").toLowerCase();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = `news/${hash.slice(0, 2)}/${hash}.${ext}`;
      await putBytes(key, bytes, file.type || "image/png");
      return { key, url: assetPublicUrl(key) };
    },
    { body: t.Object({ file: t.File() }) },
  )

  // App artwork: icon, cover and screenshots. Content-addressed like news images, so
  // re-uploading the same file is idempotent and never orphans the previous key while
  // another app still points at it. Returns the KEY — the caller writes it onto the app
  // through the normal patch, which keeps "upload" and "assign" separately reversible.
  .post(
    "/app-image",
    async ({ body, set }) => {
      const file = body.file as File;
      if (!file || file.size === 0) { set.status = 400; return { error: "missing_file" }; }
      if (file.size > 20 * 1024 * 1024) { set.status = 413; return { error: "too_large", maxBytes: 20 * 1024 * 1024 }; }
      const kind = body.kind === "cover" || body.kind === "screenshot" ? body.kind : "icon";
      const ext = (file.name.match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "png").toLowerCase();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = `apps/${kind}/${hash.slice(0, 2)}/${hash}.${ext}`;
      await putBytes(key, bytes, file.type || "image/png");
      return { key, url: assetPublicUrl(key), kind };
    },
    { body: t.Object({ file: t.File(), kind: t.Optional(t.String()) }) },
  )

  // Large builds must not stream through the API (proxies cap request bodies), so the
  // browser PUTs straight to storage: this issues the presigned URL, and /complete
  // registers the release after the upload lands.
  .post(
    "/apps/:id/releases/upload-url",
    async ({ params, body, set }) => {
      if (!storageConfigured) { set.status = 503; return { error: "storage_not_configured" }; }
      const app = await prisma.hubApp.findUnique({ where: { id: params.id }, select: { id: true, slug: true } });
      if (!app) { set.status = 404; return { error: "app_not_found" }; }
      if (body.sizeBytes > MAX_HUB_BUILD_BYTES) {
        set.status = 413;
        return { error: "too_large", maxBytes: MAX_HUB_BUILD_BYTES };
      }
      const safeName = body.fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "build.bin";
      const key = `hub/${app.slug}/${body.version}/${body.platform}/${safeName}`;
      const uploadUrl = await presignPut(key, "application/octet-stream", 3600);
      return { uploadUrl, key, expiresIn: 3600 };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        fileName: t.String({ maxLength: 200 }),
        version: t.String({ minLength: 1, maxLength: 40 }),
        channel: channelSchema,
        platform: platformSchema,
        sizeBytes: t.Numeric(),
      }),
    },
  )
  .post(
    "/apps/:id/releases/upload-complete",
    async ({ params, body, set }) => {
      const app = await prisma.hubApp.findUnique({ where: { id: params.id }, select: { id: true, slug: true } });
      if (!app) { set.status = 404; return { error: "app_not_found" }; }
      const { headObject } = await import("../storage.ts");
      const head = await headObject(body.key);
      if (!head.exists) { set.status = 400; return { error: "upload_not_found" }; }
      const release = await prisma.hubRelease.upsert({
        where: { appId_channel_platform_version: {
          appId: app.id, channel: body.channel, platform: body.platform, version: body.version,
        } },
        create: {
          appId: app.id, version: body.version, channel: body.channel, platform: body.platform,
          url: assetPublicUrl(body.key), sha256: (body.sha256 ?? "").toLowerCase(),
          sizeBytes: BigInt(head.size ?? 0), notes: body.notes ?? "",
        },
        update: {
          url: assetPublicUrl(body.key), sha256: (body.sha256 ?? "").toLowerCase(),
          sizeBytes: BigInt(head.size ?? 0), notes: body.notes ?? "",
        },
      });
      return { id: release.id, url: release.url, sizeBytes: Number(release.sizeBytes) };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Object({
        key: t.String({ maxLength: 400 }),
        version: t.String({ minLength: 1, maxLength: 40 }),
        channel: channelSchema,
        platform: platformSchema,
        sha256: t.Optional(t.String({ maxLength: 64 })),
        notes: t.Optional(t.String({ maxLength: 20_000 })),
      }),
    },
  )

  // Import the latest GitHub release of app.githubRepo as stable HubReleases. This is how
  // Serika Streaming publishes: push a release, hit sync, the Hub offers it.
  .post(
    "/apps/:id/sync-github",
    async ({ params, body, set }) => {
      const app = await prisma.hubApp.findUnique({ where: { id: params.id } });
      if (!app) { set.status = 404; return { error: "app_not_found" }; }
      const repo = (body?.repo ?? app.githubRepo ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { set.status = 400; return { error: "invalid_repo" }; }

      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { "User-Agent": "SerikaHub/0.1", Accept: "application/vnd.github+json" },
      });
      if (!res.ok) { set.status = 502; return { error: "github_error", status: res.status }; }
      const rel = await res.json() as { tag_name?: string; assets?: Array<{ name: string; size: number; browser_download_url: string }> };
      const version = (rel.tag_name ?? "").replace(/^v/, "");
      if (!version || !rel.assets?.length) { set.status = 502; return { error: "no_release_assets" }; }

      // Asset name → platform. Best-priority asset wins per platform.
      const priority = ["appimage", "exe", "dmg", "deb", "msi", "rpm", "zip"];
      const matched = new Map<string, { name: string; size: number; url: string }>();
      for (const asset of rel.assets) {
        const n = asset.name.toLowerCase();
        let platform: string | null = null;
        if (/win/.test(n) && /arm64|aarch64/.test(n)) platform = "windows-arm64";
        else if (/win|\.exe$|\.msi$/.test(n)) platform = "windows-x86_64";
        else if (/linux|\.appimage$|\.deb$|\.rpm$/.test(n) && /arm64|aarch64/.test(n)) platform = "linux-arm64";
        else if (/linux|\.appimage$|\.deb$|\.rpm$/.test(n)) platform = "linux-x86_64";
        else if (/mac|darwin|\.dmg$/.test(n) && /arm64|aarch64/.test(n)) platform = "macos-arm64";
        else if (/mac|darwin|\.dmg$/.test(n)) platform = "macos-universal";
        if (!platform) continue;
        const current = matched.get(platform);
        const rank = (name: string) => { const i = priority.findIndex((p) => name.toLowerCase().includes(p)); return i === -1 ? 99 : i; };
        if (!current || rank(asset.name) < rank(current.name)) {
          matched.set(platform, { name: asset.name, size: asset.size, url: asset.browser_download_url });
        }
      }
      if (matched.size === 0) { set.status = 502; return { error: "no_matching_assets" }; }

      const created: string[] = [];
      for (const [platform, asset] of matched) {
        await prisma.hubRelease.upsert({
          where: { appId_channel_platform_version: { appId: app.id, channel: "stable", platform, version } },
          create: {
            appId: app.id, version, channel: "stable", platform,
            url: asset.url, sha256: "", sizeBytes: BigInt(asset.size),
            notes: `${app.name} ${version} (${platform}) — imported from GitHub ${repo}.`,
          },
          update: { url: asset.url, sizeBytes: BigInt(asset.size) },
        });
        created.push(platform);
      }
      if (!app.githubRepo) await prisma.hubApp.update({ where: { id: app.id }, data: { githubRepo: repo } });
      return { version, platforms: created };
    },
    {
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      body: t.Optional(t.Object({ repo: t.Optional(t.String()) })),
    },
  );

/// Comment POST lives on its own /v1/hub instance: it is authed, and hubRoutes is public.
export const hubCommentRoutes = new Elysia({ prefix: "/v1/hub" })
  .use(authed)
  .post(
    "/news/:slug/comments",
    async ({ params, body, session, set }) => {
      const post = await prisma.newsPost.findUnique({ where: { slug: params.slug }, select: { id: true } });
      if (!post) { set.status = 404; return { error: "not_found" }; }
      const comment = await prisma.newsComment.create({
        data: { postId: post.id, userId: session.sub, body: body.body },
        include: { user: { select: { username: true, avatarUrl: true, isPremium: true } } },
      });
      return {
        comment: {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          author: { username: comment.user.username, avatarUrl: comment.user.avatarUrl, isPremium: comment.user.isPremium },
        },
      };
    },
    {
      params: t.Object({ slug: t.String() }),
      body: t.Object({ body: t.String({ minLength: 1, maxLength: 2000 }) }),
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
