-- World reviews: one rating + written review per user per world.
-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "world_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reviews_world_id_idx" ON "reviews"("world_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_world_id_user_id_key" ON "reviews"("world_id", "user_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
