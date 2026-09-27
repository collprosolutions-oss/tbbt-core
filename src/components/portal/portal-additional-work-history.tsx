import { formatDateTime } from "@/lib/format";
import type { PortalAdditionalWorkItem } from "@/lib/portal-project-home";

export function PortalAdditionalWorkHistory({
  requests,
  timeZone,
}: {
  requests: PortalAdditionalWorkItem[];
  timeZone: string;
}) {
  if (requests.length === 0) {
    return (
      <p className="mb-4 text-sm text-muted-foreground">
        You have not submitted an additional-work request on this project yet.
      </p>
    );
  }

  return (
    <div className="mb-4 space-y-3">
      {requests.map((request) => (
        <div key={request.id} className="space-y-1 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">{request.description}</p>
            <p className="text-muted-foreground">{request.statusLabel}</p>
          </div>
          {request.workLabels.length > 0 ? (
            <p className="text-muted-foreground">{request.workLabels.join(" · ")}</p>
          ) : null}
          <p className="text-muted-foreground">
            Submitted {formatDateTime(request.createdAt, timeZone)}
          </p>
        </div>
      ))}
    </div>
  );
}
