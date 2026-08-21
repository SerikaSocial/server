import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { storageConfigured, presignPut, userUploadKey, cdnUrl } from "../storage.ts";

// Direct-to-storage upload flow. The client asks for a presigned PUT URL, uploads the bytes
// itself, then the record is created. This route covers simple user uploads (profile
// images, world thumbnails). Full world/avatar bundle ingestion is assetd's job (M4) — it
// validates and re-serializes in a sandbox before anything is published.

export const assetRoutes = new Elysia({ prefix: "/v1/assets" })
  .use(authed)

  // Report whether storage is wired at all, so the client can disable upload UI cleanly
  // rather than failing mid-flow.
  .get("/status", () => ({ configured: storageConfigured }))

  // Get a presigned URL to PUT a user upload (image). Returns the eventual CDN URL too.
  .post(
    "/upload-url",
    async ({ body, session, set }) => {
      if (!storageConfigured) {
        set.status = 503;
        return { error: "storage_not_configured" };
      }
      // Guardrails: only images here, size-capped. Bundle uploads go through assetd.
      const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
      if (!allowed.includes(body.contentType)) {
        set.status = 400;
        return { error: "unsupported_content_type" };
      }
      const id = crypto.randomUUID();
      const key = userUploadKey(session.sub, id);
      const url = await presignPut(key, body.contentType);
      return { key, uploadUrl: url, cdnUrl: cdnUrl(key) };
    },
    { body: t.Object({ contentType: t.String() }) },
  );
