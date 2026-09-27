"use client";

import { useActionState, useState } from "react";
import {
  createPartnerVendorOpportunityAction,
  type DirectoryActionState,
} from "@/app/actions/partner-vendor-directory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DIRECTORY_KIND_LABELS,
  DIRECTORY_KINDS,
  DIRECTORY_SOURCE_LABELS,
  DIRECTORY_SOURCES,
} from "@/lib/partner-vendor-directory";
import type { DirectoryWorkspace } from "@/lib/partner-vendor-directory";

const initial: DirectoryActionState = {};

export function PartnerVendorCreateForm({ workspace }: { workspace: DirectoryWorkspace }) {
  const [state, formAction, pending] = useActionState(createPartnerVendorOpportunityAction, initial);
  const [source, setSource] = useState("MANUAL");

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Kind
          <select
            name="kind"
            defaultValue="VENDOR"
            className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
          >
            {DIRECTORY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {DIRECTORY_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Source
          <select
            name="source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
          >
            {DIRECTORY_SOURCES.map((item) => (
              <option key={item} value={item}>
                {DIRECTORY_SOURCE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {source === "SUPPLIER" ? (
        <label className="block text-xs text-muted-foreground">
          Existing supplier in this business
          <select
            name="supplierId"
            required
            className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
          >
            <option value="">Select a supplier</option>
            {workspace.linkableSuppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
                {supplier.active ? "" : " (inactive)"}
              </option>
            ))}
          </select>
          {workspace.overflow.suppliers ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing {workspace.linkableSuppliers.length} suppliers from this business, capped at{" "}
              {workspace.readLimit}. More matching records may exist.
            </p>
          ) : null}
        </label>
      ) : null}

      {source === "REFERRAL" ? (
        <label className="block text-xs text-muted-foreground">
          Existing referral in this business
          <select
            name="referralId"
            required
            className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-sm text-foreground"
          >
            <option value="">Select a referral</option>
            {workspace.linkableReferrals.map((referral) => (
              <option key={referral.id} value={referral.id}>
                {referral.label}
              </option>
            ))}
          </select>
          {workspace.overflow.referrals ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Showing {workspace.linkableReferrals.length} referrals from this business, capped at{" "}
              {workspace.readLimit}. More matching records may exist.
            </p>
          ) : null}
        </label>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="directory-name">Name</Label>
        <Input id="directory-name" name="name" placeholder="Firm or person the owner may work with" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="directory-summary">Summary</Label>
        <Input id="directory-summary" name="summary" placeholder="What this opportunity is for" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="directory-notes">Notes</Label>
        <textarea
          id="directory-notes"
          name="notes"
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="directory-contact">Contact name</Label>
          <Input id="directory-contact" name="contactName" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="directory-email">Contact email</Label>
          <Input id="directory-email" name="contactEmail" type="email" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="directory-phone">Contact phone</Label>
          <Input id="directory-phone" name="contactPhone" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="directory-website">Website</Label>
          <Input id="directory-website" name="website" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="directory-category">Category</Label>
          <Input id="directory-category" name="category" placeholder="Owner category, not a national taxonomy" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="directory-location">Location</Label>
          <Input id="directory-location" name="locationDescription" />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Record opportunity"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
