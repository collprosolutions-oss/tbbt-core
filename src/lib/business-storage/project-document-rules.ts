import {
  PROJECT_DOCUMENT_MAX_BYTES,
  PROJECT_DOCUMENT_MAX_FILENAME_LENGTH,
} from "@/lib/business-storage/types";

const PROJECT_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const PDF_MAGIC = Buffer.from("%PDF-");
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const RIFF_MAGIC = Buffer.from("RIFF");
const WEBP_MAGIC = Buffer.from("WEBP");

export const PROJECT_DOCUMENT_TYPE_MISMATCH =
  "That file does not match the declared type.";

export function projectDocumentMaxBytesLabel() {
  const mb = PROJECT_DOCUMENT_MAX_BYTES / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export function isProjectDocumentMimeType(value: string) {
  return PROJECT_DOCUMENT_TYPES.has(value.trim().toLowerCase());
}

export function sanitizeProjectDocumentFilename(name: string) {
  const stripped = name.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  const clipped = stripped.slice(0, PROJECT_DOCUMENT_MAX_FILENAME_LENGTH).trim();
  return clipped || "document";
}

export function resolveProjectDocumentMimeType(file: {
  type?: string | null;
  name?: string | null;
}) {
  const type = (file.type || "").trim().toLowerCase();
  if (type === "image/jpg") return "image/jpeg";
  if (PROJECT_DOCUMENT_TYPES.has(type)) return type;
  const name = (file.name || "").trim().toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  return null;
}

function startsWithBytes(body: Uint8Array, magic: Uint8Array) {
  if (body.byteLength < magic.byteLength) return false;
  for (let i = 0; i < magic.byteLength; i += 1) {
    if (body[i] !== magic[i]) return false;
  }
  return true;
}

export function projectDocumentBytesMatchMime(
  mimeType: string,
  body: Buffer | Uint8Array,
) {
  const bytes = body instanceof Buffer ? new Uint8Array(body) : body;
  switch (mimeType) {
    case "application/pdf":
      return startsWithBytes(bytes, PDF_MAGIC);
    case "image/jpeg":
      return startsWithBytes(bytes, JPEG_MAGIC);
    case "image/png":
      return startsWithBytes(bytes, PNG_MAGIC);
    case "image/webp":
      return (
        startsWithBytes(bytes, RIFF_MAGIC) &&
        bytes.byteLength >= 12 &&
        bytes[8] === WEBP_MAGIC[0] &&
        bytes[9] === WEBP_MAGIC[1] &&
        bytes[10] === WEBP_MAGIC[2] &&
        bytes[11] === WEBP_MAGIC[3]
      );
    default:
      return false;
  }
}

export function inspectProjectDocumentUpload(file: {
  type?: string | null;
  name?: string | null;
  size: number;
}) {
  const mimeType = resolveProjectDocumentMimeType(file);
  if (!mimeType) {
    return {
      ok: false as const,
      error: "Unsupported file type. Choose a PDF, JPEG, PNG, or WebP document.",
    };
  }
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > PROJECT_DOCUMENT_MAX_BYTES
  ) {
    return {
      ok: false as const,
      error: `That file is too large. The limit is ${projectDocumentMaxBytesLabel()}.`,
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: sanitizeProjectDocumentFilename(file.name || ""),
    fileSizeBytes: file.size,
  };
}
