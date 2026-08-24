"use client";

import { useActionState } from "react";
import {
  installHandymanStarterCatalog,
  type CatalogActionState,
} from "@/app/actions/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const initialState: CatalogActionState = {};

export function InstallStarterCatalogForm() {
  const [state, action, pending] = useActionState(
    async () => installHandymanStarterCatalog(),
    initialState,
  );

  return (
    <form action={action} className="space-y-3">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.message ? (
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Adding…" : "Add Handyman Starter Catalog"}
      </Button>
    </form>
  );
}
