import { formatStorageBytes, privateAssetPath } from "@/lib/business-storage/keys";
import { formatDateTime } from "@/lib/format";
import type { ProjectDocumentReviewItem } from "@/lib/business-storage/project-documents";
import { ProjectDocumentReviewForm } from "@/components/jobs/project-document-review-form";

export function ProjectDocumentReviewList({
  jobId,
  documents,
  canDecide = false,
}: {
  jobId: string;
  documents: ProjectDocumentReviewItem[];
  canDecide?: boolean;
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
        <li key={document.id} className="space-y-2 rounded-lg border p-3 text-sm">
          <p className="font-medium">{document.originalFilename}</p>
          <p className="text-muted-foreground">
            Received {formatDateTime(document.createdAt)} ·{" "}
            {formatStorageBytes(document.fileSizeBytes)}
          </p>
          <p className="text-muted-foreground">
            Private. Not approved, published, or attached to an invoice.
          </p>
          <p>
            Review: {document.reviewStatusLabel}
            {document.reviewReason ? ` · ${document.reviewReason}` : ""}
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
          {canDecide ? (
            <ProjectDocumentReviewForm
              jobId={jobId}
              storedAssetId={document.id}
              expectedStatus={document.reviewStatus ?? ""}
              defaultReason={document.reviewReason}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
