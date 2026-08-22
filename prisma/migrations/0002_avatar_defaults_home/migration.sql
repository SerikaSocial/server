-- Admin-curated default outfits + a single default Home world.
ALTER TABLE "avatars" ADD COLUMN "is_default_outfit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "avatars" ADD COLUMN "thumbnail_key" TEXT;
ALTER TABLE "worlds" ADD COLUMN "is_default_home" BOOLEAN NOT NULL DEFAULT false;
