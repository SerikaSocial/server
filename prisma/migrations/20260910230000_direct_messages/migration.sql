-- Direct messages between users. Additive; used by Hub Friends, in-game /w, and invites.
CREATE TABLE IF NOT EXISTS "direct_messages" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "from_id"    UUID NOT NULL,
  "to_id"      UUID NOT NULL,
  "body"       TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "direct_messages"
    ADD CONSTRAINT "direct_messages_from_id_fkey"
    FOREIGN KEY ("from_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "direct_messages"
    ADD CONSTRAINT "direct_messages_to_id_fkey"
    FOREIGN KEY ("to_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "direct_messages_from_to_created_idx"
  ON "direct_messages" ("from_id", "to_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "direct_messages_to_created_idx"
  ON "direct_messages" ("to_id", "created_at" DESC);
