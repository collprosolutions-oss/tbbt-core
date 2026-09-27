import Link from "next/link";
import { reviewStaffingRecommendation } from "@/app/actions/workforce";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { recommendationEvidenceKey } from "@/lib/bsos-actions";
import type { BsosRecommendation } from "@/lib/bsos";

function RecommendationFacts({ item }: { item: BsosRecommendation }) {
  return (
    <ul className="mt-1 space-y-1 text-sm">
      {item.facts.map((fact) => (
        <li key={fact.key}>
          <span className="font-medium">{fact.label}:</span> {fact.value}
        </li>
      ))}
    </ul>
  );
}

function OwnerReviewButtons({ item }: { item: BsosRecommendation }) {
  const evidenceKey = recommendationEvidenceKey(item);
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button asChild size="sm" variant="outline">
        <Link href={item.href}>Open schedule record</Link>
      </Button>
      <ActionForm action={reviewStaffingRecommendation}>
        <input type="hidden" name="recommendationKey" value={item.key} />
        <input type="hidden" name="evidenceKey" value={evidenceKey} />
        <input type="hidden" name="decision" value="ACCEPT" />
        <Button type="submit" size="sm">
          Accept
        </Button>
      </ActionForm>
      <ActionForm action={reviewStaffingRecommendation}>
        <input type="hidden" name="recommendationKey" value={item.key} />
        <input type="hidden" name="evidenceKey" value={evidenceKey} />
        <input type="hidden" name="decision" value="DISMISS" />
        <Button type="submit" size="sm" variant="outline">
          Dismiss
        </Button>
      </ActionForm>
    </div>
  );
}

export function StaffingRecommendationsPanel({
  pending,
  accepted,
  history,
  canReview,
}: {
  pending: BsosRecommendation[];
  accepted: BsosRecommendation[];
  history: BsosRecommendation[];
  canReview: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Staffing recommendations</CardTitle>
        <CardDescription>
          Deterministic review from recorded availability, skills, and schedule
          facts. Accept records an owner action-plan item. Dismiss hides the
          card until those facts change. TBBT does not assign, contact, hire, or
          reschedule anyone from this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No staffing recommendations need owner review from recorded facts.
          </p>
        ) : (
          pending.map((item) => (
            <div key={item.key} className="space-y-1 rounded-md border p-3">
              <p className="font-medium">{item.title}</p>
              <p className="text-sm text-muted-foreground">Why: {item.why}</p>
              <RecommendationFacts item={item} />
              {canReview ? (
                <OwnerReviewButtons item={item} />
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Owner review is required to accept or dismiss. No worker was
                  assigned.
                </p>
              )}
            </div>
          ))
        )}

        {accepted.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Accepted for this evidence</p>
            {accepted.map((item) => (
              <p key={item.key} className="text-sm text-muted-foreground">
                {item.title} — action recorded. No assignment or contact was
                made.
              </p>
            ))}
          </div>
        ) : null}

        {history.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">Dismissed or completed</p>
            {history.map((item) => (
              <p key={item.key} className="text-sm text-muted-foreground">
                {item.title} — hidden until recorded facts change.
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
