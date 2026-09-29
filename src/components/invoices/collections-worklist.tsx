import Link from "next/link";
import {
  recordCollectionNextStepAction,
  resolveCollectionWorkItemAction,
} from "@/app/actions/collections";
import { ActionForm } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  COLLECTIONS_NEXT_STEPS,
  COLLECTIONS_NEXT_STEP_LABELS,
  COLLECTIONS_NO_CONTACT_LABEL,
  COLLECTIONS_OVERFLOW_MESSAGE,
  type CollectionsWorklist,
} from "@/lib/collections";
import { formatDateTime } from "@/lib/format";

export function CollectionsWorklist({
  workspace,
  canWrite = false,
}: {
  workspace: CollectionsWorklist;
  canWrite?: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Unpaid invoices in this scan" value={workspace.unpaidCount} />
        <Kpi label="Shown on this worklist" value={workspace.items.length} />
        <Kpi label="Worklist bound" value={workspace.queueLimit} />
      </div>
      <p className="text-xs text-muted-foreground">
        Showing up to {workspace.queueLimit} unpaid sent invoices from a scan of{" "}
        {workspace.scanLimit}. Business timezone: {workspace.timeZone}.
        {workspace.overflow ? ` ${COLLECTIONS_OVERFLOW_MESSAGE}` : ""}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Unpaid collections worklist</CardTitle>
          <CardDescription>
            Remaining balances use recorded payments. Contact state uses recorded communication
            history. Recording a next step or resolution does not mark the invoice paid.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {workspace.items.length === 0 ? (
            <EmptyState
              title="No unpaid sent invoices"
              description="No sent invoice in this bounded scan has a remaining recorded balance."
            />
          ) : null}
          {workspace.items.map((row) => (
            <article key={row.invoiceId} className="rounded-md border border-border/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{row.customerName}</p>
                <Badge variant="outline">{row.amountDueLabel} unpaid</Badge>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                <div>
                  Invoice:{" "}
                  <Link href={row.invoiceHref} className="underline underline-offset-4">
                    {row.invoiceNumber}
                  </Link>
                </div>
                <div>Invoice total: {row.invoiceTotalLabel}</div>
                <div>Recorded payments: {row.amountPaidLabel}</div>
                <div>Unpaid balance: {row.amountDueLabel}</div>
                <div>
                  Issued: {formatDateTime(new Date(row.issuedAt), workspace.timeZone)} · {row.ageDays}d
                  ({row.agingBucket})
                </div>
                <div>Due date: not recorded</div>
                <div className="sm:col-span-2">
                  Contact:{" "}
                  {row.contact
                    ? `${row.contact.channel} ${row.contact.purpose} · ${row.contact.status} · ${formatDateTime(new Date(row.contact.occurredAt), workspace.timeZone)}${row.contact.relatedToThisInvoice ? " · related to this invoice" : ""}`
                    : COLLECTIONS_NO_CONTACT_LABEL}
                </div>
                <div className="sm:col-span-2">
                  Recorded work:{" "}
                  {row.workItem
                    ? `${row.workItem.status}${row.workItem.nextStepLabel ? ` · next step ${row.workItem.nextStepLabel}` : ""}${row.workItem.note ? ` · ${row.workItem.note}` : ""}`
                    : "No next step or resolution recorded"}
                </div>
              </dl>
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {row.customerHref ? (
                  <Link href={row.customerHref} className="underline underline-offset-4">
                    Customer
                  </Link>
                ) : null}
                {row.communicationsHref ? (
                  <Link href={row.communicationsHref} className="underline underline-offset-4">
                    Communications
                  </Link>
                ) : null}
              </div>
              {canWrite ? (
                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <ActionForm action={recordCollectionNextStepAction} className="space-y-2">
                    <input type="hidden" name="invoiceId" value={row.invoiceId} />
                    <label className="block text-sm font-medium">Record next step</label>
                    <select
                      name="nextStep"
                      defaultValue={row.workItem?.nextStep ?? "CALL"}
                      className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
                    >
                      {COLLECTIONS_NEXT_STEPS.map((step) => (
                        <option key={step} value={step}>
                          {COLLECTIONS_NEXT_STEP_LABELS[step]}
                        </option>
                      ))}
                    </select>
                    <Input
                      name="note"
                      defaultValue={row.workItem?.status === "OPEN" ? row.workItem.note : ""}
                      placeholder="Optional note"
                      maxLength={500}
                    />
                    <Button type="submit" size="sm" variant="outline">
                      Record next step
                    </Button>
                  </ActionForm>
                  <ActionForm action={resolveCollectionWorkItemAction} className="space-y-2">
                    <input type="hidden" name="invoiceId" value={row.invoiceId} />
                    <label className="block text-sm font-medium">Record resolution</label>
                    <Input
                      name="note"
                      defaultValue={row.workItem?.status === "RESOLVED" ? row.workItem.note : ""}
                      placeholder="Optional resolution note"
                      maxLength={500}
                    />
                    <Button type="submit" size="sm" variant="outline">
                      Record resolution
                    </Button>
                  </ActionForm>
                </div>
              ) : null}
            </article>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}
