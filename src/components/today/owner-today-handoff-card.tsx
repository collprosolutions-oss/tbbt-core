import Link from "next/link";
import { CreateInvoiceButton } from "@/components/invoices/create-invoice-button";
import { Button } from "@/components/ui/button";
import type { OwnerTodayHandoffItem } from "@/lib/owner-today";

export function OwnerTodayHandoffCard({ item }: { item: OwnerTodayHandoffItem }) {
  return (
    <article className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-amber-950 shadow-sm dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="text-sm font-semibold">Field completed — invoice action needed</p>
      <p className="mt-1 text-sm">{item.customerName}</p>
      <p className="mt-1 text-sm">{item.detail}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <CreateInvoiceButton jobId={item.jobId} label={item.invoiceActionLabel} />
        <Button asChild size="sm" variant="outline">
          <Link href={item.href}>Open job</Link>
        </Button>
      </div>
    </article>
  );
}
