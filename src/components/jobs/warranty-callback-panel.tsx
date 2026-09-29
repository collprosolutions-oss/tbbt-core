import { StatusBadge } from "@/components/status-badge";
import {
  RecordWarrantyCallbackForm,
  RecordWarrantyCallbackOutcomeForm,
  RecordWarrantyTermForm,
  ReviewWarrantyCallbackForm,
} from "@/components/jobs/warranty-callback-forms";
import { formatDateTime } from "@/lib/format";
import {
  NO_WARRANTY_TERMS_RECORDED_MESSAGE,
  WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE,
  WARRANTY_CALLBACK_NO_SIDE_EFFECTS_MESSAGE,
  WARRANTY_TERMS_ONLY_RECORDED_MESSAGE,
} from "@/lib/warranty-callback";
import type { WarrantyCallbackReview } from "@/lib/warranty-callback-ops";

export function WarrantyCallbackPanel({
  review,
  timeZone,
}: {
  review: WarrantyCallbackReview;
  timeZone: string;
}) {
  const when = (value: Date | null) => (value ? formatDateTime(value, timeZone) : null);

  return (
    <div className="space-y-6" data-warranty-callback-panel={review.jobId}>
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Recorded warranty terms</h3>
          <p className="text-sm text-muted-foreground">{WARRANTY_TERMS_ONLY_RECORDED_MESSAGE}</p>
        </div>
        {review.warranty.recorded ? (
          <ul className="space-y-2">
            {review.warranty.statements.map((term) => (
              <li key={term.id} className="rounded-lg border p-3 text-sm">
                <p className="whitespace-pre-wrap">{term.statement}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Recorded {when(term.recordedAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {review.warranty.emptyMessage ?? NO_WARRANTY_TERMS_RECORDED_MESSAGE}
          </p>
        )}
        {review.completed ? <RecordWarrantyTermForm jobId={review.jobId} /> : null}
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Customer callbacks</h3>
          <p className="text-sm text-muted-foreground">{WARRANTY_CALLBACK_NO_SIDE_EFFECTS_MESSAGE}</p>
        </div>
        {review.completed ? null : (
          <p className="text-sm text-muted-foreground">{WARRANTY_CALLBACK_NOT_COMPLETED_MESSAGE}</p>
        )}
        {review.callbacks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No callbacks recorded for this job.</p>
        ) : (
          <ul className="space-y-3">
            {review.callbacks.map((callback) => (
              <li key={callback.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={callback.status} />
                  <span className="text-xs text-muted-foreground">
                    Reported {when(callback.createdAt)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap">{callback.report}</p>
                {callback.reviewNote ? (
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    Review: {callback.reviewNote}
                    {callback.reviewedAt ? ` · ${when(callback.reviewedAt)}` : ""}
                  </p>
                ) : null}
                {callback.outcomeNote ? (
                  <p className="whitespace-pre-wrap">
                    Outcome: {callback.outcomeNote}
                    {callback.resolvedAt ? ` · ${when(callback.resolvedAt)}` : ""}
                  </p>
                ) : null}
                {review.completed && callback.status === "REPORTED" ? (
                  <ReviewWarrantyCallbackForm jobId={review.jobId} callbackId={callback.id} />
                ) : null}
                {review.completed && callback.status === "REVIEWED" ? (
                  <RecordWarrantyCallbackOutcomeForm
                    jobId={review.jobId}
                    callbackId={callback.id}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {review.completed ? <RecordWarrantyCallbackForm jobId={review.jobId} /> : null}
      </section>
    </div>
  );
}
