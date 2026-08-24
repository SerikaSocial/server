-- World review pipeline: submission state machine on world_versions, per-decision audit
-- (world_reviews), and a general privileged-action audit trail (audit_log).

-- AlterTable: review state machine + script flag on each world version.
ALTER TABLE "world_versions"
  ADD COLUMN "review_status"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "has_script"      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewed_by_id"  UUID,
  ADD COLUMN "reviewed_at"     TIMESTAMP(3),
  ADD COLUMN "review_notes"    TEXT NOT NULL DEFAULT '';

-- Existing published versions should stay joinable: mark them approved.
UPDATE "world_versions" v
  SET "review_status" = 5
  FROM "worlds" w
  WHERE w."published_version_id" = v."id";

-- CreateIndex
CREATE INDEX "world_versions_review_status_idx" ON "world_versions"("review_status");

-- CreateTable
CREATE TABLE "world_reviews" (
    "id" UUID NOT NULL,
    "world_version_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" INTEGER NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "self_publish" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "world_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "world_reviews_world_version_id_idx" ON "world_reviews"("world_version_id");

-- AddForeignKey
ALTER TABLE "world_reviews" ADD CONSTRAINT "world_reviews_world_version_id_fkey" FOREIGN KEY ("world_version_id") REFERENCES "world_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "subject_id" UUID,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- CreateIndex
CREATE INDEX "audit_log_subject_id_idx" ON "audit_log"("subject_id");
