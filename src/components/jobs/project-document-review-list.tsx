import { formatStorageBytes, privateAssetPath } from "@/lib/business-storage/keys";
import { formatDateTime } from "@/lib/format";
import type { ProjectDocumentReviewItem } from "@/lib/business-storage/project-documents";

export function ProjectDocumentReviewList({
  documents,
}: {
  documents: ProjectDocumentReviewItem[];
}) {
  if (documents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No customer documents have been uploaded for this project.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {documents.map((document) => (
        <li key={document.id} className="space-y-1 rounded-lg border p-3 text-sm">
          <p className="font-medium">{document.originalFilename}</p>
          <p className="text-muted-foreground">
            Received {formatDateTime(document.createdAt)} ·{" "}
            {formatStorageBytes(document.fileSizeBytes)}
          </p>
          <p className="text-muted-foreground">
            Private. Not approved, published, or attached to an invoice.
          </p>
          <p>
            <a
              href={document.reviewHref || privateAssetPath(document.id)}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-4"
            >
              Review file
            </a>
          </p>
        </li>
      ))}
    </ul>
  );
}
