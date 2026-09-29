import { PROJECT_DOCUMENT_MAX_BYTES } from "@/lib/business-storage/types";

const PROJECT_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function projectDocumentMaxBytesLabel() {
  const mb = PROJECT_DOCUMENT_MAX_BYTES / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb} MB` : `${mb.toFixed(1)} MB`;
}

export function isProjectDocumentMimeType(value: string) {
  return PROJECT_DOCUMENT_TYPES.has(value.trim().toLowerCase());
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
  if (file.size <= 0 || file.size > PROJECT_DOCUMENT_MAX_BYTES) {
    return {
      ok: false as const,
      error: `That file is too large. The limit is ${projectDocumentMaxBytesLabel()}.`,
    };
  }
  return {
    ok: true as const,
    mimeType,
    fileName: (file.name || "").trim() || "document",
    fileSizeBytes: file.size,
  };
}
