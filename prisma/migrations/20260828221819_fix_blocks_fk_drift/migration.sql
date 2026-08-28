-- Align the blocks table foreign keys with the Prisma schema.
--
-- The live development database already had these constraints (applied manually or by
-- an earlier tool), but they were never recorded in the migration history — so
-- `prisma migrate dev` reported drift on every run. This migration makes the history
-- match the schema by adding the FKs idempotently: DROP IF EXISTS then ADD, so it
-- succeeds whether or not the constraints are already present.

ALTER TABLE "blocks" DROP CONSTRAINT IF EXISTS "blocks_user_id_fkey";
ALTER TABLE "blocks" DROP CONSTRAINT IF EXISTS "blocks_blocked_id_fkey";

ALTER TABLE "blocks" ADD CONSTRAINT "blocks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_fkey"
  FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
