import { REQUEST_PHOTO_MAX_BYTES } from "@/lib/business-storage/types";

const REQUEST_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function resolveRequestPhotoMimeType(file: {
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
      error: "Unsupported file type. Choose a JPEG, PNG, or WebP photo.",
    };
  }
  if (file.size <= 0 || file.size > REQUEST_PHOTO_MAX_BYTES) {
    return {
      ok: false as const,
      error: "That photo is too large. The limit is 4 MB.",
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: (file.name || "").trim() || "photo",
    fileSizeBytes: file.size,
  };
}
