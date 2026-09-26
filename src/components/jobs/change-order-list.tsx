import Link from "next/link";
import { requireManagementPageAccess } from "@/lib/access";
import { StatusBadge } from "@/components/status-badge";
import { formatMoney } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requestedWorkLabels } from "@/lib/service-request-work";

export type ChangeOrderListItem = {
  id: string;
  title: string;
  status: string;
  total: { toString(): string };
};

type LinkedSourceRequest = {
  id: string;
  businessId: string;
  changeOrderId: string | null;
  description: string;
  source: "CUSTOMER" | "EMPLOYEE";
  items: Array<{
    quantity: number;
    customDescription: string | null;
    serviceCatalogItem: { name: string } | null;
  }>;
};

type ChangeOrderSourceAccess = {
  businessId: string;
  assertOwned: <T extends { businessId: string }>(
    record: T | null | undefined,
  ) => T;
};

/**
 * Follows AdditionalWorkRequest.changeOrderId for owner source context.
 * businessId always comes from authenticated management access — never a
 * browser-supplied businessId.
 */
export async function loadLinkedChangeOrderSourceRequests(
  access: ChangeOrderSourceAccess,
  input: { jobId: string; changeOrderIds: string[] },
) {
  if (input.changeOrderIds.length === 0) {
    return [];
  }

  const linkedRequests = await prisma.additionalWorkRequest.findMany({
    where: {
      businessId: access.businessId,
      jobId: input.jobId,
      changeOrderId: { in: input.changeOrderIds },
    },
    select: {
      id: true,
      businessId: true,
      changeOrderId: true,
      description: true,
      source: true,
      items: {
        orderBy: { sortOrder: "asc" },
        select: {
          quantity: true,
          customDescription: true,
          serviceCatalogItem: { select: { name: true } },
        },
      },
    },
  });

  return linkedRequests.map((request) => access.assertOwned(request));
}

function sourceRequestLabel(source: LinkedSourceRequest["source"]) {
  return source === "EMPLOYEE" ? "Field employee report" : "Customer request";
}

/**
 * Read-only summary list on the internal Work Order page. Each row links to
 * the change order's own detail page for editing (while DRAFT), sending,
 * cancelling, or just reviewing sent/approved/declined terms.
 *
 * When a Change Order was created from an AdditionalWorkRequest, this list
 * follows the existing changeOrderId relation and shows that recorded
 * source context — it does not copy the request into a second field.
 */
export async function ChangeOrderList({
  jobId,
  changeOrders,
}: {
  jobId: string;
  changeOrders: ChangeOrderListItem[];
}) {
  const access = await requireManagementPageAccess();

  if (changeOrders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No change orders yet.</p>
    );
  }

  const linkedRequests = await loadLinkedChangeOrderSourceRequests(access, {
    jobId,
    changeOrderIds: changeOrders.map((changeOrder) => changeOrder.id),
  });
  const sourceByChangeOrderId = new Map<string, LinkedSourceRequest>();
  for (const request of linkedRequests) {
    if (request.changeOrderId) {
      sourceByChangeOrderId.set(request.changeOrderId, request);
    }
  }

  return (
    <ul className="space-y-2">
      {changeOrders.map((changeOrder) => {
        const sourceRequest = sourceByChangeOrderId.get(changeOrder.id);
        return (
          <li
            key={changeOrder.id}
            className="space-y-2 rounded-lg border p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
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
            </div>
            {sourceRequest ? (
              <SourceRequestContext request={sourceRequest} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function SourceRequestContext({ request }: { request: LinkedSourceRequest }) {
  const serviceLabels = requestedWorkLabels(request);
  const showRecordedDescription = Boolean(
    request.description &&
      (serviceLabels.length === 0 || request.description !== serviceLabels[0]),
  );

  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>Source request: {sourceRequestLabel(request.source)}</p>
      {serviceLabels.length > 0 ? (
        <ul className="list-disc space-y-1 pl-4">
          {serviceLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : null}
      {showRecordedDescription ? (
        <p className="whitespace-pre-wrap">{request.description}</p>
      ) : null}
    </div>
  );
}
