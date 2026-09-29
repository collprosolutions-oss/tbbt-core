import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  MATERIAL_PICKUP_SCHEDULED_HEADING,
  type MaterialPickupVisibility,
} from "@/lib/owner-today";
import { PURCHASE_ITEM_STATUS_LABELS, type FieldJobPickupView } from "@/lib/materials/types";

export function AssignedJobPickupCard({
  items,
  scheduledPickup = null,
}: {
  items: FieldJobPickupView[];
  scheduledPickup?: MaterialPickupVisibility | null;
}) {
  const hasScheduledPickup = Boolean(scheduledPickup?.recorded);
  if (!hasScheduledPickup && items.length === 0) return null;

  return (
    <Card>
      {hasScheduledPickup && scheduledPickup ? (
        <>
          <CardHeader>
            <CardTitle className="text-lg leading-snug">
              {MATERIAL_PICKUP_SCHEDULED_HEADING}
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              Recorded pickup time on this job. This does not start a time card.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-base">
            <p className="font-medium tabular-nums">{scheduledPickup.minutesLabel}</p>
            {scheduledPickup.blockLabel ? (
              <p className="tabular-nums">{scheduledPickup.blockLabel}</p>
            ) : null}
            {scheduledPickup.scheduledNote ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {scheduledPickup.scheduledNote}
              </p>
            ) : null}
          </CardContent>
        </>
      ) : null}
      {items.length > 0 ? (
        <>
          <CardHeader className={hasScheduledPickup ? "pt-0" : undefined}>
            <CardTitle>Material pickup</CardTitle>
            <CardDescription>
              Pickup for this assigned job only. Company vendor pricing is not shown.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {items.map((item) => (
              <div key={item.id} className="rounded-lg border p-3">
                <p className="font-medium">
                  {item.name} · {item.quantityNeeded} {item.unit}
                </p>
                <p className="text-muted-foreground">
                  {item.supplierName ?? "No supplier listed"}
                  {item.pickupLocationDescription ? ` · ${item.pickupLocationDescription}` : ""}
                </p>
                <p className="text-muted-foreground">
                  {item.pickupReady ? "Ready for pickup" : "Not marked ready"}
                  {item.pickupDurationMinutes != null ? ` · about ${item.pickupDurationMinutes} min` : ""}
                  {" · "}
                  {PURCHASE_ITEM_STATUS_LABELS[item.status]}
                </p>
                {item.pickupRecorded ? (
                  <p className="text-muted-foreground">
                    {item.quantityPickedUp
                      ? `Picked up ${item.quantityPickedUp} ${item.unit}`
                      : "Exception recorded"}
                    {item.pickupExceptionLabel ? ` · ${item.pickupExceptionLabel}` : ""}
                    {item.pickupExceptionNote ? ` · ${item.pickupExceptionNote}` : ""}
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </>
      ) : null}
    </Card>
  );
}
