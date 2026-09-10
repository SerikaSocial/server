-- Store-page content for HubApp.
--
-- Purely additive: every column is nullable or defaulted, so an old API build keeps
-- working against a migrated database and this can be deployed before the code that
-- reads it. `cover_key` is deliberately separate from `icon_key` — a square icon
-- stretched into a banner is exactly what the procedural placeholder art was hiding.
ALTER TABLE "hub_apps"
  ADD COLUMN IF NOT EXISTS "cover_key"   TEXT,
  ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "tagline"     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "developer"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "publisher"   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "screenshots" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "tags"        TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "support_url" TEXT,
  ADD COLUMN IF NOT EXISTS "source_url"  TEXT,
  ADD COLUMN IF NOT EXISTS "trailer_url" TEXT,
  ADD COLUMN IF NOT EXISTS "sort_order"  INTEGER NOT NULL DEFAULT 0;

-- The catalogue is ordered by sort_order then name on every request.
CREATE INDEX IF NOT EXISTS "hub_apps_sort_order_name_idx" ON "hub_apps" ("sort_order", "name");
