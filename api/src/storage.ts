import { S3Client, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// S3-compatible object storage. The plan's default backend is Backblaze B2 (already used by
// serika-accounts); this code is backend-agnostic, so Cloudflare R2 or plain S3 work by
// changing only the endpoint/region env. Nothing here assumes B2 specifically.
//
// Uploads are content-addressed (key = blake3 of the bytes) and PUT directly by the client
// via a presigned URL — a 200MB world must never stream through this Bun process.

const endpoint = process.env.B2_ENDPOINT ?? "";
const bucket = process.env.B2_BUCKET_NAME ?? "serika-social";

export const storageConfigured = Boolean(
  process.env.B2_KEY_ID && process.env.B2_APP_KEY && endpoint,
);

const client = storageConfigured
  ? new S3Client({
      endpoint: `https://${endpoint}`,
      region: process.env.B2_REGION ?? "us-west-000",
      credentials: {
        accessKeyId: process.env.B2_KEY_ID!,
        secretAccessKey: process.env.B2_APP_KEY!,
      },
    })
  : null;

export const cdnBase = process.env.CDN_BASE_URL ?? "";

/// Content-addressed key layout. `blake3` is the lowercase hex digest supplied by the
/// client (and re-verified by assetd before publish).
export function assetKey(kind: "av" | "wl", blake3: string, platform: "win" | "linux" | "android"): string {
  const prefix = blake3.slice(0, 2);
  const ext = kind === "av" ? "ska" : "skw";
  return `${kind}/${prefix}/${blake3}/${platform}.${ext}`;
}

export function userUploadKey(userId: string, id: string): string {
  return `ug/${userId}/${id}`;
}

/// Presigned PUT so the client uploads straight to storage. Short expiry — the client
/// should already hold the bytes and upload immediately.
export async function presignPut(key: string, contentType: string, expiresSeconds = 300): Promise<string> {
  if (!client) throw new Error("storage not configured (B2_* env unset)");
  const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
  return getSignedUrl(client, cmd, { expiresIn: expiresSeconds });
}

/// Confirm an object exists and get its size — used after a client reports an upload done,
/// before we record it in Postgres.
export async function headObject(key: string): Promise<{ exists: boolean; size?: number }> {
  if (!client) throw new Error("storage not configured");
  try {
    const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, size: r.ContentLength };
  } catch {
    return { exists: false };
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!client) throw new Error("storage not configured");
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/// Public CDN URL for a content-addressed key. Immutable, so cacheable forever.
export function cdnUrl(key: string): string {
  return cdnBase ? `${cdnBase.replace(/\/$/, "")}/${key}` : key;
}
