import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PURCHASE_ITEM_STATUS_LABELS, type FieldJobPickupView } from "@/lib/materials/types";

export function AssignedJobPickupCard({ items }: { items: FieldJobPickupView[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader>
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
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
