-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "accounts_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "is_premium" BOOLEAN NOT NULL DEFAULT false,
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "trust_level" INTEGER NOT NULL DEFAULT 0,
    "current_avatar_id" UUID,
    "last_seen" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "friends" (
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friends_pkey" PRIMARY KEY ("user_a_id","user_b_id")
);

-- CreateTable
CREATE TABLE "blocks" (
    "user_id" UUID NOT NULL,
    "blocked_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocks_pkey" PRIMARY KEY ("user_id","blocked_id")
);

-- CreateTable
CREATE TABLE "worlds" (
    "id" UUID NOT NULL,
    "author_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capacity" INTEGER NOT NULL DEFAULT 16,
    "release_status" INTEGER NOT NULL DEFAULT 0,
    "force_dedicated" BOOLEAN NOT NULL DEFAULT false,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "published_version_id" UUID,
    "visit_count" BIGINT NOT NULL DEFAULT 0,
    "heat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worlds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "world_versions" (
    "id" UUID NOT NULL,
    "world_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "build_status" INTEGER NOT NULL DEFAULT 0,
    "validator_report" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "world_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "world_assets" (
    "version_id" UUID NOT NULL,
    "platform" INTEGER NOT NULL,
    "blake3" BYTEA NOT NULL,
    "bytes" BIGINT NOT NULL,
    "cdn_key" TEXT NOT NULL,

    CONSTRAINT "world_assets_pkey" PRIMARY KEY ("version_id","platform")
);

-- CreateTable
CREATE TABLE "avatars" (
    "id" UUID NOT NULL,
    "author_id" UUID,
    "name" TEXT NOT NULL,
    "release_status" INTEGER NOT NULL DEFAULT 0,
    "perf_rank" INTEGER NOT NULL DEFAULT 0,
    "source_format" INTEGER NOT NULL DEFAULT 0,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "published_version_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "avatar_versions" (
    "id" UUID NOT NULL,
    "avatar_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "blake3" BYTEA,
    "stats" JSONB,
    "cdn_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatar_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instances" (
    "id" UUID NOT NULL,
    "world_id" UUID NOT NULL,
    "world_version_id" UUID,
    "owner_id" UUID,
    "access" INTEGER NOT NULL DEFAULT 0,
    "mode" INTEGER NOT NULL DEFAULT 1,
    "region" TEXT NOT NULL DEFAULT 'eu-central',
    "node_id" TEXT,
    "endpoint" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 16,
    "player_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favorites" (
    "user_id" UUID NOT NULL,
    "kind" INTEGER NOT NULL,
    "target_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("user_id","kind","target_id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "target_id" UUID NOT NULL,
    "instance_id" UUID,
    "kind" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_accounts_id_key" ON "users"("accounts_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_last_seen_idx" ON "users"("last_seen" DESC);

-- CreateIndex
CREATE INDEX "friends_user_b_id_idx" ON "friends"("user_b_id");

-- CreateIndex
CREATE INDEX "worlds_tags_idx" ON "worlds" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "worlds_heat_idx" ON "worlds"("heat" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "world_versions_world_id_version_key" ON "world_versions"("world_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_versions_avatar_id_version_key" ON "avatar_versions"("avatar_id", "version");

-- CreateIndex
CREATE INDEX "instances_world_id_closed_at_idx" ON "instances"("world_id", "closed_at");

-- CreateIndex
CREATE INDEX "instances_node_id_idx" ON "instances"("node_id");

-- CreateIndex
CREATE INDEX "moderation_actions_target_id_idx" ON "moderation_actions"("target_id");

-- AddForeignKey
ALTER TABLE "friends" ADD CONSTRAINT "friends_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "friends" ADD CONSTRAINT "friends_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_versions" ADD CONSTRAINT "world_versions_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "world_assets" ADD CONSTRAINT "world_assets_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "world_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "avatar_versions" ADD CONSTRAINT "avatar_versions_avatar_id_fkey" FOREIGN KEY ("avatar_id") REFERENCES "avatars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instances" ADD CONSTRAINT "instances_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instances" ADD CONSTRAINT "instances_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

