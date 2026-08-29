import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AddChangeOrderLineItemForm } from "@/components/change-orders/add-change-order-line-item-form";
import { CancelChangeOrderButton } from "@/components/change-orders/cancel-change-order-button";
import { EditChangeOrderTitleForm } from "@/components/change-orders/edit-change-order-title-form";
import { RemoveChangeOrderLineItemButton } from "@/components/change-orders/remove-change-order-line-item-button";
import { SendChangeOrderButton } from "@/components/change-orders/send-change-order-button";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { requireManagementPageAccess } from "@/lib/access";
import { formatDateTime, formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Change Order",
};

export default async function ChangeOrderPage({
  params,
}: {
  params: Promise<{ jobId: string; changeOrderId: string }>;
}) {
  const { jobId, changeOrderId } = await params;
  const access = await requireManagementPageAccess();
  const changeOrder = await prisma.changeOrder.findFirst({
    where: { id: changeOrderId, jobId, ...access.scope },
    include: {
      job: { select: { id: true, customer: { select: { name: true } } } },
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPrice: true,
          total: true,
          type: true,
        },
      },
    },
  });

  if (!changeOrder) {
    notFound();
  }
  access.assertOwned(changeOrder);

  const isDraft = changeOrder.status === "DRAFT";
  const canCancel = changeOrder.status === "DRAFT" || changeOrder.status === "SENT";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title=""
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>Change Order</span>
            <StatusBadge status={changeOrder.status} />
            <span>{changeOrder.job.customer?.name ?? "Customer"}</span>
          </div>
        }
      >
        <Link
          href={`/jobs/${jobId}`}
          className="text-sm underline underline-offset-4"
        >
          Back to Work Order
        </Link>
      </PageHeader>

      {isDraft ? (
        <EditChangeOrderTitleForm
          changeOrderId={changeOrder.id}
          title={changeOrder.title}
        />
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight">
          {changeOrder.title}
        </h1>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>Created {formatDateTime(changeOrder.createdAt)}</p>
          {changeOrder.sentAt ? (
            <p>Sent {formatDateTime(changeOrder.sentAt)}</p>
          ) : null}
          {changeOrder.approvedAt ? (
            <p>Approved {formatDateTime(changeOrder.approvedAt)}</p>
          ) : null}
          {changeOrder.declinedAt ? (
            <p>Declined {formatDateTime(changeOrder.declinedAt)}</p>
          ) : null}
          {changeOrder.cancelledAt ? (
            <p>Cancelled {formatDateTime(changeOrder.cancelledAt)}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Line Items</CardTitle>
          <CardDescription>
            {isDraft
              ? "Add, remove, or edit line items freely -- nothing is customer-facing yet."
              : "These are the exact terms sent to the customer. They cannot be edited anymore -- cancel this change order and create a new one if a correction is needed."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {changeOrder.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {changeOrder.lineItems.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words">
                    {item.description} × {item.quantity.toString()} @{" "}
                    {formatMoney(item.unitPrice)}
                  </span>
                  <span className="shrink-0">{formatMoney(item.total)}</span>
                  {isDraft ? (
                    <RemoveChangeOrderLineItemButton
                      changeOrderId={changeOrder.id}
                      lineItemId={item.id}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="font-medium">
            Change order total: {formatMoney(changeOrder.total)}
          </p>
          {isDraft ? (
            <AddChangeOrderLineItemForm changeOrderId={changeOrder.id} />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {isDraft ? (
            <SendChangeOrderButton
              changeOrderId={changeOrder.id}
              disabled={changeOrder.lineItems.length === 0}
            />
          ) : null}
          {changeOrder.status === "SENT" ? (
            <p className="text-sm text-muted-foreground">
              Waiting on the customer to approve or decline from their
              project portal.
            </p>
          ) : null}
          {canCancel ? (
            <CancelChangeOrderButton changeOrderId={changeOrder.id} />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
