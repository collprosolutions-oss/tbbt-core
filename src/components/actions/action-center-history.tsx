import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ControlledAiActionHistory } from "@/lib/chief-of-staff/controlled-ai-provenance";

function TargetLink({
  href,
  label,
}: {
  href: string | null;
  label: string | null;
}) {
  if (!label) return <span>Recommendation</span>;
  if (!href) return <span>{label}</span>;
  return (
    <Link className="text-primary underline-offset-4 hover:underline" href={href}>
      {label}
    </Link>
  );
}

export function ActionCenterHistoryList({ history }: { history: ControlledAiActionHistory }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirmed Controlled AI actions</CardTitle>
        <CardDescription>
          Durable provenance for explicitly confirmed Controlled AI attempts.
          Generic owner-plan rows are not shown here and are not inferred as AI
          actions. Newest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {history.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No confirmed Controlled AI actions have been recorded yet.
          </p>
        ) : (
          history.attempts.map((row) => (
            <div key={row.id} className="rounded-md border p-3">
              <p className="font-medium">{row.displayLabel}</p>
              <p className="text-sm text-muted-foreground">
                Result: {row.result}
                {row.resultCode ? ` · ${row.resultCode}` : ""}
              </p>
              <p className="mt-1 text-sm">
                Recommendation:{" "}
                <TargetLink href={row.targetHref} label={row.recommendationLabel} />
              </p>
              <p className="text-xs text-muted-foreground">
                Confirmed {row.confirmedAtLabel}
                {row.executedAtLabel ? ` · Recorded ${row.executedAtLabel}` : ""}
              </p>
              {row.confirmedByName ? (
                <p className="text-xs text-muted-foreground">Confirmed by {row.confirmedByName}</p>
              ) : null}
              <p className="mt-1 text-sm">{row.resultMessage}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
