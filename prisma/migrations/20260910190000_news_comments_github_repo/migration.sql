-- News comments (in-app article comments) + GitHub repo source for HubApp.

-- AlterTable
ALTER TABLE "hub_apps" ADD COLUMN "github_repo" TEXT;

-- AlterTable
ALTER TABLE "hub_apps" ADD COLUMN "github_repo" TEXT;

-- CreateTable
CREATE TABLE "hub_news_comments" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hub_news_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hub_news_comments_post_id_created_at_idx" ON "hub_news_comments"("post_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "hub_news_comments" ADD CONSTRAINT "hub_news_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "hub_news_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hub_news_comments" ADD CONSTRAINT "hub_news_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
