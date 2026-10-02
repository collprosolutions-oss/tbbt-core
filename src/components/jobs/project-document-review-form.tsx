"use client";

import { useActionState } from "react";
import {
  recordProjectDocumentReviewAction,
  type ProjectDocumentReviewActionState,
} from "@/app/actions/project-document-review";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  MAX_PROJECT_DOCUMENT_REVIEW_REASON_LENGTH,
  PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL,
  PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL,
} from "@/lib/project-document-review";

const initialState: ProjectDocumentReviewActionState = {};

export function ProjectDocumentReviewForm({
  jobId,
  storedAssetId,
  expectedStatus,
  defaultReason,
}: {
  jobId: string;
  storedAssetId: string;
  expectedStatus: string;
  defaultReason?: string | null;
}) {
  const [state, action, pending] = useActionState(
    recordProjectDocumentReviewAction,
    initialState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="storedAssetId" value={storedAssetId} />
      <input type="hidden" name="expectedStatus" value={expectedStatus} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      <div className="space-y-1">
        <Label htmlFor={`project-document-reason-${storedAssetId}`}>
          Optional reason
        </Label>
        <textarea
          id={`project-document-reason-${storedAssetId}`}
          name="reason"
          rows={2}
          maxLength={MAX_PROJECT_DOCUMENT_REVIEW_REASON_LENGTH}
          defaultValue={defaultReason ?? ""}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Records a review only. The file stays private. This does not publish
        the document, attach it to an invoice, or send a customer message.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          name="status"
          value="REVIEWED"
          size="sm"
          disabled={pending}
        >
          {pending ? "Saving…" : PROJECT_DOCUMENT_REVIEW_REVIEWED_LABEL}
        </Button>
        <Button
          type="submit"
          name="status"
          value="NEEDS_REPLACEMENT"
          size="sm"
          variant="outline"
          disabled={pending}
        >
          {pending ? "Saving…" : PROJECT_DOCUMENT_REVIEW_NEEDS_REPLACEMENT_LABEL}
        </Button>
      </div>
    </form>
  );
}
