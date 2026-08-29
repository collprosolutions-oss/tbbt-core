import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime, formatMoney } from "@/lib/format";

export type EstimateVersionSummary = {
  id: string;
  versionNumber: number;
  total: { toString(): string };
  sentAt: Date;
  approvedAt: Date | null;
};

/**
 * Read-only history of every immutable snapshot created by a Send. Confirms
 * version history exists without exposing any editing surface -- historical
 * versions are never editable through the UI.
 */
export function EstimateVersionHistory({
  versions,
}: {
  versions: EstimateVersionSummary[];
}) {
  if (versions.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Version history</CardTitle>
        <CardDescription>
          A read-only record of every version sent to the customer. Editing
          returns the estimate to draft; sending again creates the next
          version. Past versions never change.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span>
                Version {version.versionNumber} · Sent{" "}
                {formatDateTime(version.sentAt)}
              </span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {formatMoney(version.total)}
                {version.approvedAt ? (
                  <span className="font-medium text-foreground">
                    Approved
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
