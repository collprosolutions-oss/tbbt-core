"use client";

import { useActionState } from "react";
import {
  createServiceCatalogItem,
  type CatalogActionState,
} from "@/app/actions/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: CatalogActionState = {};

export function CreateCatalogItemForm() {
  const [state, action, pending] = useActionState(
    createServiceCatalogItem,
    initialState,
  );

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="price">Starting price</Label>
        <Input id="price" name="price" inputMode="decimal" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="description">Description (optional)</Label>
        <textarea
          id="description"
          name="description"
          rows={4}
          className="min-h-20 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none md:text-sm"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add service"}
      </Button>
    </form>
  );
}
