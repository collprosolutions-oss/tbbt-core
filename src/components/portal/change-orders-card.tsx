import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApproveDeclineChangeOrderButtons } from "@/components/portal/approve-decline-change-order-buttons";
import { customerFacingChangeOrderStatusLabel } from "@/lib/change-order";
import { formatMoney } from "@/lib/format";

export type PortalChangeOrder = {
  id: string;
  title: string;
  status: string;
  total: { toString(): string };
  lineItems: {
    description: string;
    quantity: { toString(): string };
    unitPrice: { toString(): string };
    total: { toString(): string };
  }[];
};

/**
 * Customer-facing Change Orders / Additional Work section on
 * src/app/p/[token]/page.tsx. Only ever receives change orders already
 * filtered to customer-visible statuses (SENT/APPROVED/DECLINED -- see
 * CUSTOMER_VISIBLE_CHANGE_ORDER_STATUSES in src/lib/change-order.ts) for
 * exactly this Job. A DRAFT change order is never passed in here.
 */
export function ChangeOrdersCard({
  projectToken,
  changeOrders,
}: {
  projectToken: string;
  changeOrders: PortalChangeOrder[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Change Orders / Additional Work</CardTitle>
        <CardDescription>
          These are ADDITIONAL work items beyond your original approved
          project, each with its own ADDITIONAL cost. They only count toward
          your project total once you approve them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {changeOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No additional work has been proposed yet.
          </p>
        ) : (
          changeOrders.map((changeOrder) => (
            <div key={changeOrder.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{changeOrder.title}</p>
                <p className="text-muted-foreground">
                  {customerFacingChangeOrderStatusLabel(changeOrder.status)}
                </p>
              </div>
              {changeOrder.lineItems.length > 0 ? (
                <ul className="space-y-1">
                  {changeOrder.lineItems.map((item, index) => (
                    <li key={index} className="flex justify-between gap-3">
                      <span className="min-w-0 flex-1 break-words">
                        {item.description} × {item.quantity.toString()} @{" "}
                        {formatMoney(item.unitPrice)}
                      </span>
                      <span className="shrink-0">{formatMoney(item.total)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="font-medium">
                Additional cost: {formatMoney(changeOrder.total)}
              </p>
              {changeOrder.status === "SENT" ? (
                <ApproveDeclineChangeOrderButtons
                  projectToken={projectToken}
                  changeOrderId={changeOrder.id}
                />
              ) : null}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
