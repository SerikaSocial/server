-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "reporter_id" UUID NOT NULL,
    "target_type" INTEGER NOT NULL,
    "target_user_id" UUID,
    "target_world_id" UUID,
    "category" INTEGER NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "instance_id" UUID,
    "status" INTEGER NOT NULL DEFAULT 0,
    "resolved_by_id" UUID,
    "resolution_notes" TEXT NOT NULL DEFAULT '',
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "reports_reporter_id_status_idx" ON "reports"("reporter_id", "status");

-- CreateIndex
CREATE INDEX "reports_target_user_id_idx" ON "reports"("target_user_id");

-- CreateIndex
CREATE INDEX "reports_target_world_id_idx" ON "reports"("target_world_id");

-- AddForeignKey
-- (The blocks-table FK repairs Prisma wanted here were trimmed: they are pre-existing drift
-- on the live DB, not part of this change, and bundling them would make deploy fail on any
-- database that already has those constraints. Fix blocks drift separately if desired.)
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_fkey" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_world_id_fkey" FOREIGN KEY ("target_world_id") REFERENCES "worlds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
