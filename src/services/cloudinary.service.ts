import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env.js';

let isConfigured = false;

if (env.cloudinaryCloudName && env.cloudinaryApiKey && env.cloudinaryApiSecret) {
  cloudinary.config({
    cloud_name: env.cloudinaryCloudName,
    api_key: env.cloudinaryApiKey,
    api_secret: env.cloudinaryApiSecret,
    secure: true,
  });
  isConfigured = true;
  console.log('[Cloudinary] Successfully configured Cloudinary SDK.');
} else {
  console.warn('[Cloudinary] Warning: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET missing in environment variables. Falling back to secure data URL storage.');
}

export function isCloudinaryConfigured(): boolean {
  return isConfigured;
}

export interface CloudinaryUploadResult {
  url: string;
  secure_url: string;
  public_id: string;
  format?: string;
  bytes?: number;
}

export async function uploadBufferToCloudinary(
  buffer: Buffer,
  fileName: string,
  folder = 'bni_conclaves/agendas'
): Promise<CloudinaryUploadResult | null> {
  if (!isConfigured) {
    return null;
  }

  return new Promise((resolve) => {
    const cleanFileName = fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
    
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: `${cleanFileName}_${Date.now()}`,
        resource_type: 'auto',
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary] Upload stream error:', error);
          return resolve(null);
        }
        if (!result) {
          return resolve(null);
        }
        resolve({
          url: result.url,
          secure_url: result.secure_url,
          public_id: result.public_id,
          format: result.format,
          bytes: result.bytes,
        });
      }
    );

    uploadStream.end(buffer);
  });
}

export async function uploadBase64ToCloudinary(
  base64DataUrl: string,
  fileName: string,
  folder = 'bni_conclaves/agendas'
): Promise<CloudinaryUploadResult | null> {
  if (!isConfigured) {
    return null;
  }

  try {
    const cleanFileName = fileName.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
    const result = await cloudinary.uploader.upload(base64DataUrl, {
      folder,
      public_id: `${cleanFileName}_${Date.now()}`,
      resource_type: 'auto',
    });

    return {
      url: result.url,
      secure_url: result.secure_url,
      public_id: result.public_id,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (err) {
    console.error('[Cloudinary] Base64 upload error:', err);
    return null;
  }
}

export async function deleteCloudinaryAsset(publicId: string): Promise<boolean> {
  if (!isConfigured || !publicId) return false;
  try {
    await cloudinary.uploader.destroy(publicId);
    return true;
  } catch (err) {
    console.error('[Cloudinary] Delete asset error:', err);
    return false;
  }
}
