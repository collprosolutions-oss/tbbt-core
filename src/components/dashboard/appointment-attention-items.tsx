import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { DashboardAppointmentAttentionItem } from "@/lib/dashboard-appointment-attention";

export function DashboardAppointmentAttentionItems({
  items,
}: {
  items: DashboardAppointmentAttentionItem[];
}) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <Link
          key={item.jobId}
          href={item.href}
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-950/60"
        >
          <AlertTriangle
            className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden
          />
          <div className="min-w-0 space-y-1">
            <p className="font-semibold">{item.title}</p>
            <p>
              {item.customerName} — {item.whenLabel}
            </p>
            {item.customerNote ? <p>Customer note: “{item.customerNote}”</p> : null}
          </div>
        </Link>
      ))}
    </div>
  );
}
