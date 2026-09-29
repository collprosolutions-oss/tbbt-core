import { RecordEquipmentItemForm } from "@/components/equipment/record-item-form";
import { RecordEquipmentMaintenanceForm } from "@/components/equipment/record-maintenance-form";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EQUIPMENT_UNAVAILABLE_MESSAGE } from "@/lib/equipment";
import type { EquipmentItemView, EquipmentWorkspace as EquipmentWorkspaceData } from "@/lib/equipment";

function ServiceBadge({ item }: { item: EquipmentItemView }) {
  if (!item.serviceOn) {
    return <Badge variant="secondary">No service date</Badge>;
  }
  return item.due ? (
    <Badge variant="warning">Due {item.serviceOn}</Badge>
  ) : (
    <Badge variant="success">Service {item.serviceOn}</Badge>
  );
}

function EquipmentCard({
  item,
  canWrite,
  timeZone,
}: {
  item: EquipmentItemView;
  canWrite: boolean;
  timeZone: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>
              {item.name}{" "}
              <span className="text-sm font-normal text-muted-foreground">{item.kindLabel}</span>
            </CardTitle>
            {item.notes ? <CardDescription>{item.notes}</CardDescription> : null}
          </div>
          <ServiceBadge item={item} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {item.purchaseExpense ? (
          <p className="text-sm text-muted-foreground">
            Purchase: {item.purchaseExpense.occurredOn} · {item.purchaseExpense.description}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No purchase expense linked.</p>
        )}
        <div>
          <h3 className="text-sm font-medium text-foreground">Maintenance</h3>
          {item.maintenance.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">No manual maintenance entries yet.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {item.maintenance.map((entry) => (
                <li key={entry.id}>
                  <span className="text-muted-foreground">{entry.occurredOn}</span> · {entry.notes}
                </li>
              ))}
            </ul>
          )}
          {item.maintenanceOverflow ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing the most recent recorded entries, capped for this item.
            </p>
          ) : null}
        </div>
        {canWrite ? <RecordEquipmentMaintenanceForm item={item} /> : null}
        <p className="sr-only">Timezone {timeZone}</p>
      </CardContent>
    </Card>
  );
}

export function EquipmentWorkspace({ workspace }: { workspace: EquipmentWorkspaceData }) {
  if (!workspace.available) {
    return <EmptyState title="Equipment unavailable" description={EQUIPMENT_UNAVAILABLE_MESSAGE} />;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Due from recorded dates</CardTitle>
          <CardDescription>{workspace.dueMessage}</CardDescription>
        </CardHeader>
        <CardContent>
          {workspace.dueItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing is due. Items without a recorded service date are not listed here.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {workspace.dueItems.map((item) => (
                <li key={item.id}>
                  {item.name} · {item.kindLabel} · service {item.serviceOn}
                </li>
              ))}
            </ul>
          )}
          {workspace.dueOverflow ? (
            <p className="mt-2 text-xs text-muted-foreground">{workspace.overflowMessage}</p>
          ) : null}
        </CardContent>
      </Card>

      {workspace.canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Record an item</CardTitle>
            <CardDescription>
              {workspace.ownerOnlyMessage} {workspace.purchaseMessage}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecordEquipmentItemForm workspace={workspace} />
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">{workspace.ownerOnlyMessage}</p>
      )}

      {workspace.items.length === 0 ? (
        <EmptyState
          title="No tools or vehicles yet"
          description={`${workspace.limitsMessage} ${workspace.fieldScopedMessage}`}
        />
      ) : (
        <div className="space-y-3">
          {workspace.overflow ? (
            <p className="text-xs text-muted-foreground">
              Showing {workspace.items.length} items, capped at {workspace.readLimit}.{" "}
              {workspace.overflowMessage}
            </p>
          ) : null}
          {workspace.items.map((item) => (
            <EquipmentCard
              key={item.id}
              item={item}
              canWrite={workspace.canWrite}
              timeZone={workspace.timeZone}
            />
          ))}
        </div>
      )}
    </div>
  );
}
