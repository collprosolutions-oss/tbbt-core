"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { createCustomer, type CustomerActionState } from "@/app/actions/customer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, type buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { VariantProps } from "class-variance-authority";

const initialState: CustomerActionState = {};

/**
 * The real "+ New Customer" action from the locked Customers mockup --
 * both the shared header's primary action and the right rail's "Add New
 * Customer" CTA render an instance of this same self-contained trigger +
 * slide-over form (see createCustomer() in src/app/actions/customer.ts).
 * Each instance owns its own open state; Sheet's content renders through
 * a portal, so it overlays the full page regardless of which part of the
 * tree (AppShell header slot vs. this page's own rail) this instance
 * lives in.
 */
export function NewCustomerForm({
  label = "New Customer",
  size = "sm",
  variant = "default",
  className,
  showIcon = true,
}: {
  label?: string;
  size?: VariantProps<typeof buttonVariants>["size"];
  variant?: VariantProps<typeof buttonVariants>["variant"];
  className?: string;
  showIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createCustomer, initialState);
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      setOpen(false);
    }
    wasPending.current = pending;
  }, [pending, state]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button type="button" size={size} variant={variant} className={className} onClick={() => setOpen(true)}>
        {showIcon ? <UserPlus className="size-4" /> : null}
        {label}
      </Button>
      <SheetContent side="right" className="flex flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New customer</SheetTitle>
          <SheetDescription>
            Add a customer directly. You can add a service address now or later
            from their profile.
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
          {state.error ? (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="new-customer-name">Name</Label>
            <Input id="new-customer-name" name="name" autoComplete="name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-customer-phone">Phone (optional)</Label>
            <Input id="new-customer-phone" name="phone" type="tel" autoComplete="tel" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-customer-email">Email (optional)</Label>
            <Input id="new-customer-email" name="email" type="email" autoComplete="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-customer-address">Service address (optional)</Label>
            <Input id="new-customer-address" name="address" autoComplete="street-address" />
          </div>
          <SheetFooter className="mt-auto flex-row justify-end px-0">
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create customer"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
