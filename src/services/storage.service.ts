import { randomUUID } from "node:crypto";
import { storage } from "../config/firebase.js";
import { env } from "../config/env.js";

/**
 * File storage on Firebase Cloud Storage (this project's own bucket) — replaces
 * the third-party Cloudinary account.
 *
 * Access model: each upload gets an unguessable Firebase download token embedded
 * in its metadata. The resulting `?alt=media&token=…` URL is the ONLY way to
 * reach the file, and the token is the access grant — so it keeps working under
 * a locked-down bucket (`allow read, write: if false`) while nothing can be
 * listed or browsed. Rotating/removing the token metadata revokes the link.
 *
 * This mirrors how the Firebase client SDK's getDownloadURL() works, without the
 * app needing the client SDK.
 */

export interface StorageUploadResult {
  /** Public download URL (unguessable token). Store this on the document. */
  url: string;
  /** Object path within the bucket. Store it too, so the file can be deleted. */
  path: string;
  bytes: number;
}

function bucket() {
  return storage.bucket(env.firebaseStorageBucket);
}

export async function uploadBufferToStorage(
  buffer: Buffer,
  fileName: string,
  contentType: string,
  folder = "agendas",
): Promise<StorageUploadResult | null> {
  try {
    const clean = fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
    const ext = (fileName.match(/\.[^/.]+$/)?.[0] ?? "").toLowerCase();
    const path = `${folder}/${clean}_${Date.now()}${ext}`;
    const token = randomUUID();

    const file = bucket().file(path);
    await file.save(buffer, {
      contentType,
      resumable: false,
      metadata: {
        // This token is what makes the download URL work under deny-all rules.
        metadata: { firebaseStorageDownloadTokens: token },
      },
    });

    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket().name}` +
      `/o/${encodeURIComponent(path)}?alt=media&token=${token}`;

    return { url, path, bytes: buffer.length };
  } catch (err) {
    console.error("[Storage] upload error:", err);
    return null;
  }
}

export async function deleteStorageAsset(path: string): Promise<boolean> {
  if (!path) return false;
  try {
    await bucket().file(path).delete();
    return true;
  } catch (err) {
    console.error("[Storage] delete error:", err);
    return false;
  }
}
