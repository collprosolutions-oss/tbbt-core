"use client";

import { useActionState } from "react";
import {
  setServiceCatalogItemActive,
  updateServiceCatalogItem,
  type CatalogActionState,
} from "@/app/actions/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: CatalogActionState = {};

type CatalogItemRowProps = {
  id: string;
  name: string;
  price: string;
  displayPrice: string;
  description: string;
  active: boolean;
};

export function CatalogItemRow({
  id,
  name,
  price,
  displayPrice,
  description,
  active,
}: CatalogItemRowProps) {
  const [state, action, pending] = useActionState(
    updateServiceCatalogItem,
    initialState,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">
            Starting price {displayPrice}
          </p>
        </div>
        <Badge variant={active ? "secondary" : "outline"}>
          {active ? "Active" : "Inactive"}
        </Badge>
      </div>

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      <form action={action} className="space-y-3">
        <input type="hidden" name="id" value={id} />
        <div className="space-y-2">
          <Label htmlFor={`name-${id}`}>Name</Label>
          <Input id={`name-${id}`} name="name" defaultValue={name} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`price-${id}`}>Starting price</Label>
          <Input
            id={`price-${id}`}
            name="price"
            inputMode="decimal"
            defaultValue={price}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`description-${id}`}>Description (optional)</Label>
          <textarea
            id={`description-${id}`}
            name="description"
            defaultValue={description}
            rows={4}
            className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
          />
        </div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>

      <form
        action={async () => {
          await setServiceCatalogItemActive(id, !active);
        }}
      >
        <Button type="submit" variant="outline" size="sm">
          {active ? "Deactivate" : "Reactivate"}
        </Button>
      </form>
    </div>
  );
}
