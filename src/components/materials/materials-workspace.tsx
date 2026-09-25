"use client";

import { useActionState } from "react";
import {
  createCatalogItemAction,
  createSupplierAction,
  updateCatalogItemAction,
  updateSupplierAction,
  type MaterialsActionState,
} from "@/app/actions/materials";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/format";
import { SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION } from "@/lib/materials/adapter";
import { SUPPLIER_INTEGRATION_LICENSING_NOTICE } from "@/lib/materials/types";

const initial: MaterialsActionState = {};

export type MaterialsSupplierRow = {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  accountReference: string | null;
  preferred: boolean;
  notes: string | null;
  active: boolean;
  categories: string | null;
  locationDescription: string | null;
};

export type MaterialsCatalogRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  packSize: string | null;
  preferredSupplierId: string | null;
  preferredSupplierName: string | null;
  lastKnownCost: string | null;
  notes: string | null;
  category: string | null;
  takeoffIdentity: string | null;
  active: boolean;
  history: Array<{
    id: string;
    price: string;
    observedAt: string;
    source: string;
    supplierName: string | null;
  }>;
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

export function MaterialsWorkspace({
  suppliers,
  catalog,
}: {
  suppliers: MaterialsSupplierRow[];
  catalog: MaterialsCatalogRow[];
}) {
  const [createSupplierState, createSupplier, creatingSupplier] = useActionState(
    createSupplierAction,
    initial,
  );
  const [createCatalogState, createCatalog, creatingCatalog] = useActionState(
    createCatalogItemAction,
    initial,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Supplier adapter</CardTitle>
          <CardDescription>
            Connection state is <strong>DISCONNECTED</strong>. Live Home Depot / Lowe’s
            lookup, quotes, availability, and cart handoff are not built in this release.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{SUPPLIER_COMMERCE_DISCONNECTED_LIMITATION}</p>
          <p>{SUPPLIER_INTEGRATION_LICENSING_NOTICE}</p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Add supplier</CardTitle>
            <CardDescription>
              Tenant vendor record. Account references only — no passwords or API secrets.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createSupplier} className="space-y-3">
              <FormStatus state={createSupplierState} />
              <div className="space-y-1.5">
                <Label htmlFor="supplier-name">Name</Label>
                <Input id="supplier-name" name="name" required />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="contactName">Contact</Label>
                  <Input id="contactName" name="contactName" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="contactPhone">Phone</Label>
                  <Input id="contactPhone" name="contactPhone" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="website">Website / reference</Label>
                <Input id="website" name="website" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="accountReference">Account / vendor #</Label>
                <Input id="accountReference" name="accountReference" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="categories">Categories / trades</Label>
                <Input id="categories" name="categories" placeholder="Concrete, lumber" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="locationDescription">Pickup location</Label>
                <Input id="locationDescription" name="locationDescription" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes</Label>
                <Input id="notes" name="notes" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="preferred" value="1" />
                Preferred supplier
              </label>
              <Button type="submit" disabled={creatingSupplier}>
                {creatingSupplier ? "Saving…" : "Save supplier"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add material</CardTitle>
            <CardDescription>
              Reusable business item. Changing last known cost appends history; it does not
              rewrite sent estimates.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createCatalog} className="space-y-3">
              <FormStatus state={createCatalogState} />
              <div className="space-y-1.5">
                <Label htmlFor="material-name">Name</Label>
                <Input id="material-name" name="name" required />
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" name="sku" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="unit">Unit</Label>
                  <Input id="unit" name="unit" defaultValue="ea" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="packSize">Pack size</Label>
                  <Input id="packSize" name="packSize" />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="lastKnownCost">Last known cost</Label>
                  <Input id="lastKnownCost" name="lastKnownCost" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="preferredSupplierId">Preferred supplier</Label>
                  <select
                    id="preferredSupplierId"
                    name="preferredSupplierId"
                    className="h-8 w-full rounded-md border bg-transparent px-2.5 text-sm"
                    defaultValue=""
                  >
                    <option value="">None</option>
                    {suppliers
                      .filter((supplier) => supplier.active)
                      .map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                          {supplier.preferred ? " (preferred)" : ""}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <Input id="category" name="category" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="material-notes">Notes</Label>
                <Input id="material-notes" name="notes" />
              </div>
              <Button type="submit" disabled={creatingCatalog}>
                {creatingCatalog ? "Saving…" : "Save material"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Suppliers</CardTitle>
          <CardDescription>Preferred vendors and pickup locations for this business only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {suppliers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No suppliers yet.</p>
          ) : (
            suppliers.map((supplier) => (
              <SupplierEditForm key={supplier.id} supplier={supplier} />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Material catalog</CardTitle>
          <CardDescription>
            Last known cost is current. Price history stays append-only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {catalog.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reusable materials yet.</p>
          ) : (
            catalog.map((item) => <CatalogEditForm key={item.id} item={item} suppliers={suppliers} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SupplierEditForm({ supplier }: { supplier: MaterialsSupplierRow }) {
  const [state, action, pending] = useActionState(updateSupplierAction, initial);
  return (
    <form action={action} className="space-y-2 rounded-lg border p-3">
      <FormStatus state={state} />
      <input type="hidden" name="supplierId" value={supplier.id} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Input name="name" defaultValue={supplier.name} required />
        <Input name="contactName" defaultValue={supplier.contactName ?? ""} placeholder="Contact" />
        <Input name="website" defaultValue={supplier.website ?? ""} placeholder="Website" />
        <Input
          name="accountReference"
          defaultValue={supplier.accountReference ?? ""}
          placeholder="Account / vendor #"
        />
        <Input name="categories" defaultValue={supplier.categories ?? ""} placeholder="Categories" />
        <Input
          name="locationDescription"
          defaultValue={supplier.locationDescription ?? ""}
          placeholder="Pickup location"
        />
      </div>
      <Input name="notes" defaultValue={supplier.notes ?? ""} placeholder="Notes" />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="preferred" value="1" defaultChecked={supplier.preferred} />
          Preferred
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="inactive" value="1" defaultChecked={!supplier.active} />
          Inactive
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Update"}
        </Button>
      </div>
    </form>
  );
}

function CatalogEditForm({
  item,
  suppliers,
}: {
  item: MaterialsCatalogRow;
  suppliers: MaterialsSupplierRow[];
}) {
  const [state, action, pending] = useActionState(updateCatalogItemAction, initial);
  return (
    <form action={action} className="space-y-2 rounded-lg border p-3">
      <FormStatus state={state} />
      <input type="hidden" name="materialId" value={item.id} />
      <div className="grid gap-2 sm:grid-cols-3">
        <Input name="name" defaultValue={item.name} required />
        <Input name="sku" defaultValue={item.sku ?? ""} placeholder="SKU" />
        <Input name="unit" defaultValue={item.unit} />
        <Input name="packSize" defaultValue={item.packSize ?? ""} placeholder="Pack" />
        <Input
          name="lastKnownCost"
          defaultValue={item.lastKnownCost ?? ""}
          placeholder="Last known cost"
        />
        <select
          name="preferredSupplierId"
          defaultValue={item.preferredSupplierId ?? ""}
          className="h-8 rounded-md border bg-transparent px-2.5 text-sm"
        >
          <option value="">No preferred supplier</option>
          {suppliers
            .filter((supplier) => supplier.active)
            .map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
        </select>
      </div>
      <Input name="category" defaultValue={item.category ?? ""} placeholder="Category" />
      <Input name="notes" defaultValue={item.notes ?? ""} placeholder="Notes" />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="inactive" value="1" defaultChecked={!item.active} />
          Inactive
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Update material"}
        </Button>
      </div>
      {item.history.length > 0 ? (
        <ul className="text-xs text-muted-foreground">
          {item.history.slice(0, 5).map((row) => (
            <li key={row.id}>
              {formatMoney(row.price)} · {row.source} · {row.observedAt}
              {row.supplierName ? ` · ${row.supplierName}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
