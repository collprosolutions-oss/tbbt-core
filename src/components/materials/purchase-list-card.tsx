"use client";

import { useActionState } from "react";
import {
  addPurchaseListItemAction,
  convertTakeoffToPurchaseListAction,
  createPurchaseOrderAction,
  recordPurchaseAction,
  updatePurchaseListItemAction,
  updatePurchaseOrderStatusAction,
  type MaterialsActionState,
} from "@/app/actions/materials";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/format";
import {
  PURCHASE_ITEM_STATUSES,
  PURCHASE_ITEM_STATUS_LABELS,
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUS_LABELS,
} from "@/lib/materials/types";

const initial: MaterialsActionState = {};

export type PurchaseListItemView = {
  id: string;
  name: string;
  quantityNeeded: string;
  unit: string;
  plannedUnitCost: string | null;
  plannedCost: string | null;
  quantityPurchased: string | null;
  actualUnitCost: string | null;
  actualCost: string | null;
  financialCost: string | null;
  expenseId: string | null;
  markupPercent: string | null;
  customerUnitPrice: string | null;
  pickupRequired: boolean;
  pickupLocationDescription: string | null;
  pickupDurationMinutes: number | null;
  pickupReady: boolean;
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  materialId: string | null;
};

export type PurchaseOrderView = {
  id: string;
  status: string;
  supplierName: string | null;
};

export type MaterialVarianceView = {
  name: string;
  estimatedQuantity: number | null;
  estimatedCost: number | null;
  purchasedQuantity: number | null;
  purchasedCost: number | null;
  costDelta: number | null;
};

function FormStatus({ state }: { state: MaterialsActionState }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  if (state.message) {
    return (
      <Alert>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

export function PurchaseListCard({
  estimateId,
  jobId,
  purchaseListId,
  items,
  orders,
  variance,
  suppliers,
  canConvertTakeoff,
}: {
  estimateId?: string | null;
  jobId?: string | null;
  purchaseListId: string | null;
  items: PurchaseListItemView[];
  orders: PurchaseOrderView[];
  variance: MaterialVarianceView[];
  suppliers: Array<{ id: string; name: string }>;
  canConvertTakeoff?: boolean;
}) {
  const [convertState, convertAction, converting] = useActionState(
    convertTakeoffToPurchaseListAction,
    initial,
  );
  const [addState, addAction, adding] = useActionState(addPurchaseListItemAction, initial);
  const [poState, poAction, creatingPo] = useActionState(createPurchaseOrderAction, initial);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Material purchase list</CardTitle>
        <CardDescription>
          Needed vs purchased for this job/estimate. TBBT does not place supplier orders.
          Changing a supplier price does not rewrite the customer invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canConvertTakeoff && estimateId ? (
          <form action={convertAction} className="space-y-2">
            <FormStatus state={convertState} />
            <input type="hidden" name="estimateId" value={estimateId} />
            <Button type="submit" size="sm" disabled={converting}>
              {converting ? "Converting…" : "Convert takeoff / materials into purchase list"}
            </Button>
          </form>
        ) : null}

        {purchaseListId ? (
          <form action={addAction} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-6">
            <FormStatus state={addState} />
            <input type="hidden" name="purchaseListId" value={purchaseListId} />
            {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
            {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
            <Input name="name" placeholder="Material" required className="sm:col-span-2" />
            <Input name="quantityNeeded" placeholder="Qty" required />
            <Input name="unit" placeholder="Unit" defaultValue="ea" />
            <Input name="plannedUnitCost" placeholder="Planned cost" />
            <select name="supplierId" className="h-8 rounded-md border bg-transparent px-2 text-sm">
              <option value="">Supplier</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="pickupRequired" value="1" />
              Pickup required
            </label>
            <Input name="pickupLocationDescription" placeholder="Pickup location" className="sm:col-span-2" />
            <Input name="pickupDurationMinutes" placeholder="Minutes" />
            <Button type="submit" size="sm" disabled={adding}>
              {adding ? "Adding…" : "Add"}
            </Button>
          </form>
        ) : null}

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No purchase-list items yet.</p>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <PurchaseItemForm
                key={item.id}
                item={item}
                suppliers={suppliers}
                purchaseListId={purchaseListId ?? ""}
                jobId={jobId}
                estimateId={estimateId}
              />
            ))}
          </div>
        )}

        {variance.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-medium">Estimate vs actual</h3>
            <ul className="space-y-1 text-sm">
              {variance.map((row) => (
                <li key={row.name} className="flex justify-between gap-3">
                  <span>{row.name}</span>
                  <span className="text-muted-foreground">
                    est {row.estimatedQuantity ?? "—"} / {row.estimatedCost != null ? formatMoney(row.estimatedCost) : "—"}
                    {" → "}
                    actual {row.purchasedQuantity ?? "—"} / {row.purchasedCost != null ? formatMoney(row.purchasedCost) : "—"}
                    {row.costDelta != null ? ` (${row.costDelta > 0 ? "+" : ""}${formatMoney(row.costDelta)})` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {purchaseListId ? (
          <form action={poAction} className="flex flex-wrap items-end gap-2">
            <FormStatus state={poState} />
            <input type="hidden" name="purchaseListId" value={purchaseListId} />
            {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
            <select name="supplierId" className="h-8 rounded-md border bg-transparent px-2 text-sm">
              <option value="">PO supplier</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="outline" disabled={creatingPo}>
              {creatingPo ? "Creating…" : "Create draft PO"}
            </Button>
          </form>
        ) : null}

        {orders.map((order) => (
          <PurchaseOrderStatusForm key={order.id} order={order} jobId={jobId} />
        ))}
      </CardContent>
    </Card>
  );
}

function PurchaseItemForm({
  item,
  suppliers,
  purchaseListId,
  jobId,
  estimateId,
}: {
  item: PurchaseListItemView;
  suppliers: Array<{ id: string; name: string }>;
  purchaseListId: string;
  jobId?: string | null;
  estimateId?: string | null;
}) {
  const [state, action, pending] = useActionState(updatePurchaseListItemAction, initial);
  const [purchaseState, purchaseAction, recording] = useActionState(recordPurchaseAction, initial);
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <form action={action} className="grid gap-2 sm:grid-cols-6">
        <FormStatus state={state} />
        <input type="hidden" name="itemId" value={item.id} />
        <input type="hidden" name="purchaseListId" value={purchaseListId} />
        {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
        {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
        {item.materialId ? <input type="hidden" name="materialId" value={item.materialId} /> : null}
        <Input name="name" defaultValue={item.name} className="sm:col-span-2" />
        <Input name="quantityNeeded" defaultValue={item.quantityNeeded} />
        <Input name="unit" defaultValue={item.unit} />
        <Input name="plannedUnitCost" defaultValue={item.plannedUnitCost ?? ""} />
        <select
          name="status"
          defaultValue={item.status}
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
        >
          {PURCHASE_ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {PURCHASE_ITEM_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <select
          name="supplierId"
          defaultValue={item.supplierId ?? ""}
          className="h-8 rounded-md border bg-transparent px-2 text-sm sm:col-span-2"
        >
          <option value="">Supplier</option>
          {suppliers.map((supplier) => (
            <option key={supplier.id} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="pickupRequired" value="1" defaultChecked={item.pickupRequired} />
          Pickup
        </label>
        <Input
          name="pickupLocationDescription"
          defaultValue={item.pickupLocationDescription ?? ""}
          placeholder="Location"
        />
        <Input
          name="pickupDurationMinutes"
          defaultValue={item.pickupDurationMinutes ?? ""}
          placeholder="Min"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="pickupReady" value="1" defaultChecked={item.pickupReady} />
          Ready
        </label>
        <Input name="customerUnitPrice" defaultValue={item.customerUnitPrice ?? ""} placeholder="Customer $" />
        <Input name="markupPercent" defaultValue={item.markupPercent ?? ""} placeholder="Markup %" />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Planned {item.plannedCost ? formatMoney(item.plannedCost) : "—"}
        {" · "}
        Actual {item.actualCost ? formatMoney(item.actualCost) : "—"}
        {" · "}
        Expense {item.financialCost ? formatMoney(item.financialCost) : "not linked"}
        {item.expenseId ? " (no double count)" : ""}
      </p>
      <form action={purchaseAction} className="flex flex-wrap items-end gap-2">
        <FormStatus state={purchaseState} />
        <input type="hidden" name="itemId" value={item.id} />
        {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
        {estimateId ? <input type="hidden" name="estimateId" value={estimateId} /> : null}
        <Input name="quantityPurchased" defaultValue={item.quantityPurchased ?? item.quantityNeeded} className="w-24" />
        <Input name="actualUnitCost" defaultValue={item.actualUnitCost ?? ""} placeholder="Actual $" className="w-28" />
        <Input name="occurredOn" type="date" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="createExpense" value="1" />
          Record expense
        </label>
        <Button type="submit" size="sm" variant="outline" disabled={recording}>
          {recording ? "Recording…" : "Mark purchased"}
        </Button>
      </form>
    </div>
  );
}

function PurchaseOrderStatusForm({
  order,
  jobId,
}: {
  order: PurchaseOrderView;
  jobId?: string | null;
}) {
  const [state, action, pending] = useActionState(updatePurchaseOrderStatusAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
      <FormStatus state={state} />
      <input type="hidden" name="purchaseOrderId" value={order.id} />
      {jobId ? <input type="hidden" name="jobId" value={jobId} /> : null}
      <span>
        PO {order.id.slice(-6).toUpperCase()}
        {order.supplierName ? ` · ${order.supplierName}` : ""}
      </span>
      <select
        name="status"
        defaultValue={order.status}
        className="h-8 rounded-md border bg-transparent px-2 text-sm"
      >
        {PURCHASE_ORDER_STATUSES.map((status) => (
          <option key={status} value={status}>
            {PURCHASE_ORDER_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Update PO"}
      </Button>
    </form>
  );
}
