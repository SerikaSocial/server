-- Optional account preference. Existing users continue using the platform default.
ALTER TABLE "users" ADD COLUMN "home_world_id" UUID;
ALTER TABLE "users" ADD CONSTRAINT "users_home_world_id_fkey"
  FOREIGN KEY ("home_world_id") REFERENCES "worlds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
