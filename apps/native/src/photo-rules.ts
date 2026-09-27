export const NATIVE_JOB_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
export const NATIVE_JOB_PHOTO_LIMIT = 12;

const PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function nativeJobPhotoMaxBytesLabel() {
  return "12 MB";
}

export function resolveNativeJobPhotoMimeType(file: {
  type?: string | null;
  name?: string | null;
}) {
  const type = (file.type || "").trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (PHOTO_TYPES.has(type)) return type;
  const name = (file.name || "").trim().toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return null;
}

export function inspectNativeJobPhoto(file: {
  type?: string | null;
  name?: string | null;
  size: number;
}) {
  const mimeType = resolveNativeJobPhotoMimeType(file);
  if (!mimeType) {
    return {
      ok: false as const,
      error: "Unsupported file type. Choose a JPEG, PNG, WebP, or HEIC photo.",
    };
  }
  if (file.size <= 0 || file.size > NATIVE_JOB_PHOTO_MAX_BYTES) {
    return {
      ok: false as const,
      error: `That photo is too large. The limit is ${nativeJobPhotoMaxBytesLabel()}.`,
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: (file.name || "").trim() || "photo.jpg",
    fileSizeBytes: file.size,
  };
}
