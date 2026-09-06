import { REQUEST_PHOTO_MAX_BYTES } from "@/lib/business-storage/types";

const REQUEST_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function requestPhotoMaxBytesLabel() {
  const mb = REQUEST_PHOTO_MAX_BYTES / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export function isRequestPhotoMimeType(value: string) {
  return REQUEST_IMAGE_TYPES.has(value.trim().toLowerCase());
}

export function resolveRequestPhotoMimeType(file: {
  type?: string | null;
  name?: string | null;
}) {
  const type = (file.type || "").trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (REQUEST_IMAGE_TYPES.has(type)) return type;
  const name = (file.name || "").trim().toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return null;
}

export function inspectRequestPhotoUpload(file: {
  type?: string | null;
  name?: string | null;
  size: number;
}) {
  const mimeType = resolveRequestPhotoMimeType(file);
  if (!mimeType) {
    return {
      ok: false as const,
      error: "Unsupported file type. Choose a JPEG, PNG, WebP, or HEIC photo.",
    };
  }
  if (file.size <= 0 || file.size > REQUEST_PHOTO_MAX_BYTES) {
    return {
      ok: false as const,
      error: `That photo is too large. The limit is ${requestPhotoMaxBytesLabel()}.`,
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: (file.name || "").trim() || "photo",
    fileSizeBytes: file.size,
  };
}
