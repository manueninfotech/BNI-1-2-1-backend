import { randomUUID } from "node:crypto";
import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { env } from "../config/env.js";
import { ApiError } from "../middleware/errors.js";

/**
 * File storage on Azure Blob Storage (replaces Firebase Storage).
 *
 * Access model: blobs live in a PRIVATE container. The link stored on a record
 * points at OUR API (`/api/files/<path>`), which answers with a redirect to a
 * short-lived (10 min) read-only SAS URL. So:
 *  - no permanent public URL to the file exists anywhere;
 *  - deleting the blob revokes every link;
 *  - paths contain a random UUID, so they can't be guessed or listed.
 *
 * The provider is swappable (in-memory for tests).
 */

export interface StoredFile {
  /** Link to store on the record — our API, never a raw storage URL. */
  url: string;
  /** Blob path inside the container; keep it so the file can be deleted. */
  path: string;
  bytes: number;
  contentType: string;
}

export interface StorageProvider {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  signedReadUrl(path: string, ttlSeconds: number): Promise<string | null>;
  remove(path: string): Promise<void>;
}

/** What may be uploaded, and how big. */
export const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
export const MAX_BYTES = 10 * 1024 * 1024;
const LINK_TTL_SECONDS = 10 * 60;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function azureProvider(): StorageProvider {
  const service = BlobServiceClient.fromConnectionString(env.azureStorageConnectionString);
  const container = service.getContainerClient(env.azureStorageContainer);
  let ensured: Promise<unknown> | null = null;
  const ensure = () => (ensured ??= container.createIfNotExists()); // private by default

  return {
    async put(path, data, contentType) {
      await ensure();
      await container.getBlockBlobClient(path).uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    async signedReadUrl(path, ttlSeconds) {
      const blob = container.getBlobClient(path);
      if (!(await blob.exists())) return null;
      const cred = service.credential;
      if (!(cred instanceof StorageSharedKeyCredential)) throw new Error("Storage account key required to sign links.");
      const sas = generateBlobSASQueryParameters(
        {
          containerName: container.containerName,
          blobName: path,
          permissions: BlobSASPermissions.parse("r"),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn: new Date(Date.now() + ttlSeconds * 1000),
        },
        cred,
      ).toString();
      return `${blob.url}?${sas}`;
    },
    async remove(path) {
      await container.getBlobClient(path).deleteIfExists();
    },
  };
}

/** In-memory store for tests and local development without Azure. */
export function memoryProvider(): StorageProvider & { files: Map<string, { data: Buffer; contentType: string }> } {
  const files = new Map<string, { data: Buffer; contentType: string }>();
  return {
    files,
    async put(path, data, contentType) {
      files.set(path, { data, contentType });
    },
    async signedReadUrl(path) {
      return files.has(path) ? `memory://${path}` : null;
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

let provider: StorageProvider | null = null;
function store(): StorageProvider {
  if (!provider) {
    if (!env.azureStorageConnectionString) throw new ApiError(503, "File storage is not configured.");
    provider = azureProvider();
  }
  return provider;
}
/** Test/dev hook: use a different provider. */
export function setStorageProvider(p: StorageProvider | null) {
  provider = p;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const safeName = (name: string) =>
  name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "file";
const extOf = (name: string) => (name.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0] ?? "").toLowerCase();

/** Parses a `data:<type>;base64,<data>` URL (what the admin panel sends). */
export function decodeDataUrl(dataUrl: string): { contentType: string; data: Buffer } {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw ApiError.badRequest("File must be sent as a base64 data URL.");
  return { contentType: m[1].toLowerCase(), data: Buffer.from(m[2], "base64") };
}

export async function uploadFile(folder: string, fileName: string, contentType: string, data: Buffer): Promise<StoredFile> {
  if (!ALLOWED_TYPES.has(contentType)) throw ApiError.badRequest("Only PDF, Word or image files can be uploaded.");
  if (data.length === 0) throw ApiError.badRequest("The file is empty.");
  if (data.length > MAX_BYTES) throw ApiError.badRequest(`Files must be ${MAX_BYTES / 1024 / 1024} MB or smaller.`);
  const path = `${folder}/${randomUUID()}/${safeName(fileName)}${extOf(fileName)}`;
  await store().put(path, data, contentType);
  return { url: `/api/files/${path}`, path, bytes: data.length, contentType };
}

/** A short-lived direct link to the file, or null if it doesn't exist. */
export async function signedLink(path: string): Promise<string | null> {
  if (!/^[a-z0-9_-]+\/[0-9a-f-]{36}\/[A-Za-z0-9_.-]+$/.test(path)) return null;
  return store().signedReadUrl(path, LINK_TTL_SECONDS);
}

export async function deleteFile(path: string | null | undefined) {
  if (!path) return;
  await store().remove(path).catch((e) =>
    console.error(JSON.stringify({ level: "error", msg: "storage delete failed", path, err: (e as Error).message })),
  );
}
