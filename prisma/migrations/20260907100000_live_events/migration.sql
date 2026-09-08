ALTER TABLE "worlds" ADD COLUMN "is_unlisted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "event_only" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "live_events" (
  "id" UUID NOT NULL, "world_id" UUID NOT NULL, "title" TEXT NOT NULL,
  "banner_key" TEXT NOT NULL, "config" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft',
  "revision" INTEGER NOT NULL DEFAULT 0, "started_at" TIMESTAMP(3), "created_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "live_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "live_events_world_id_fkey" FOREIGN KEY ("world_id") REFERENCES "worlds"("id") ON DELETE CASCADE,
  CONSTRAINT "live_events_status_check" CHECK ("status" IN ('draft','open','live','ended'))
);
CREATE INDEX "live_events_status_idx" ON "live_events"("status");
ALTER TABLE "instances" ADD COLUMN "event_id" UUID;
ALTER TABLE "instances" ADD CONSTRAINT "instances_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "live_events"("id") ON DELETE SET NULL;
CREATE INDEX "instances_event_id_idx" ON "instances"("event_id");

CREATE UNIQUE INDEX "live_events_one_open_world" ON "live_events"("world_id") WHERE "status" IN ('open', 'live');
