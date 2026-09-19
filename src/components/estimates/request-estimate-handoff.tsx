import { RequestIntakeContext } from "@/components/estimates/request-intake-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  OwnerIntakeMeasurementView,
  OwnerIntakePhoto,
} from "@/lib/intake-quote-handoff";
import {
  REQUEST_ESTIMATE_HANDOFF_TITLE,
  type RequestedWorkStarterRow,
} from "@/lib/request-estimate-handoff";

export function RequestEstimateHandoff({
  rows,
  notes,
  customerName,
  customerEmail,
  customerPhone,
  serviceAddress,
  workAreaLabels,
  photos,
  measurements,
}: {
  rows: RequestedWorkStarterRow[];
  notes: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  serviceAddress: string | null;
  workAreaLabels: string[];
  photos: OwnerIntakePhoto[];
  measurements: OwnerIntakeMeasurementView[];
}) {
  const hasContact = Boolean(
    customerName || customerEmail || customerPhone,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{REQUEST_ESTIMATE_HANDOFF_TITLE}</CardTitle>
        <CardDescription>
          What this customer asked you to do. Starting labor comes from the
          requested service and is not a guaranteed final price.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        {rows.length > 0 ? (
          <div className="space-y-4">
            <p className="font-medium">Requested work</p>
            <ul className="space-y-4">
              {rows.map((row, index) => (
                <li key={`${row.name}-${row.quantity}-${index}`} className="space-y-1">
                  <p className="text-base font-semibold text-foreground">
                    {row.name}
                  </p>
                  <p>Quantity: {row.quantity}</p>
                  {row.startingLaborLabel ? (
                    <p>{row.startingLaborLabel}</p>
                  ) : null}
                  {row.includedScope ? (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        Included scope
                      </p>
                      <p className="whitespace-pre-line">{row.includedScope}</p>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {notes ? (
          <div>
            <p className="font-medium">Customer notes</p>
            <p className="whitespace-pre-line">{notes}</p>
          </div>
        ) : null}
        {workAreaLabels.length > 0 ? (
          <div>
            <p className="font-medium">Customer work-area answers</p>
            <ul className="list-disc pl-5">
              {workAreaLabels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {hasContact ? (
          <div>
            <p className="font-medium">Customer</p>
            {customerName ? <p>{customerName}</p> : null}
            {customerPhone ? <p>{customerPhone}</p> : null}
            {customerEmail ? <p>{customerEmail}</p> : null}
          </div>
        ) : null}
        {serviceAddress ? (
          <div>
            <p className="font-medium">Service address</p>
            <p>{serviceAddress}</p>
          </div>
        ) : null}
        <RequestIntakeContext photos={photos} measurements={measurements} />
      </CardContent>
    </Card>
  );
}
