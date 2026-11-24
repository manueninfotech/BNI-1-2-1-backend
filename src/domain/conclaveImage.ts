import type { ConclaveImage } from "../db/schema.js";

/** What clients see of a stored conclave image: link and name, never the storage path. */
export function publicImage(img: ConclaveImage | null | undefined) {
  return img?.url ? { id: img.id, url: img.url, name: img.name } : null;
}
