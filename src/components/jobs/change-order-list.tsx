import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatMoney } from "@/lib/format";

export type ChangeOrderListItem = {
  id: string;
  title: string;
  status: string;
  total: { toString(): string };
};

/**
 * Read-only summary list on the internal Work Order page. Each row links to
 * the change order's own detail page for editing (while DRAFT), sending,
 * cancelling, or just reviewing sent/approved/declined terms.
 */
export function ChangeOrderList({
  jobId,
  changeOrders,
}: {
  jobId: string;
  changeOrders: ChangeOrderListItem[];
}) {
  if (changeOrders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No change orders yet.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {changeOrders.map((changeOrder) => (
        <li
          key={changeOrder.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <StatusBadge status={changeOrder.status} />
            <Link
              href={`/jobs/${jobId}/change-orders/${changeOrder.id}`}
              className="min-w-0 truncate underline underline-offset-4"
            >
              {changeOrder.title}
            </Link>
          </div>
          <span className="shrink-0 font-medium">
            {formatMoney(changeOrder.total)}
          </span>
        </li>
      ))}
    </ul>
  );
}
