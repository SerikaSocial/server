-- Hub backend: news posts, the desktop-app catalogue, releases, and per-user
-- world-visit history. Additive only; no existing table is altered.

-- CreateTable
CREATE TABLE "hub_news_posts" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "image_key" TEXT,
    "app_id" UUID,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "author_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_news_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_apps" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blurb" TEXT NOT NULL DEFAULT '',
    "icon_key" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'app',
    "homepage" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "hub_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_releases" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_world_visits" (
    "user_id" UUID NOT NULL,
    "world_id" UUID NOT NULL,
    "visited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_world_visits_pkey" PRIMARY KEY ("user_id","world_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hub_news_posts_slug_key" ON "hub_news_posts"("slug");

-- CreateIndex
CREATE INDEX "hub_news_posts_published_at_idx" ON "hub_news_posts"("published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "hub_apps_slug_key" ON "hub_apps"("slug");

-- CreateIndex
CREATE INDEX "hub_releases_app_id_platform_published_at_idx" ON "hub_releases"("app_id", "platform", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "hub_releases_app_id_channel_platform_version_key" ON "hub_releases"("app_id", "channel", "platform", "version");

-- CreateIndex
CREATE INDEX "user_world_visits_user_id_visited_at_idx" ON "user_world_visits"("user_id", "visited_at" DESC);

-- AddForeignKey
ALTER TABLE "hub_news_posts" ADD CONSTRAINT "hub_news_posts_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "hub_apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_news_posts" ADD CONSTRAINT "hub_news_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_releases" ADD CONSTRAINT "hub_releases_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "hub_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_world_visits" ADD CONSTRAINT "user_world_visits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
