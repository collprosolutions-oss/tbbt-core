"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  completeWebsiteSetupAction,
  skipWebsiteSetupAction,
  type WebsiteSetupState,
} from "@/app/actions/website-setup";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_PUBLIC_ABOUT_COPY_LENGTH } from "@/lib/website-story";

const initialState: WebsiteSetupState = {};

export function WebsiteSetupForm({
  businessName,
  publicPhone,
  publicEmail,
  approvedPublicAboutCopy,
  publicServiceAreaLabel,
  previewHref,
}: {
  businessName: string;
  publicPhone: string;
  publicEmail: string;
  approvedPublicAboutCopy: string;
  publicServiceAreaLabel: string;
  previewHref: string;
}) {
  const [state, action, pending] = useActionState(
    completeWebsiteSetupAction,
    initialState,
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-3 text-sm">
        <p className="font-medium">Your public site</p>
        <p className="mt-1 break-all text-muted-foreground">{previewHref}</p>
        <Link
          href={previewHref}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: "outline", className: "mt-3 w-full" })}
        >
          Preview public site
        </Link>
      </div>

      <form action={action} className="space-y-4">
        {state.error ? (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="businessName">Public business name</Label>
          <Input
            id="businessName"
            name="businessName"
            defaultValue={businessName}
            autoComplete="organization"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="publicPhone">Public phone</Label>
          <Input
            id="publicPhone"
            name="publicPhone"
            defaultValue={publicPhone}
            autoComplete="tel"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="publicEmail">Public email</Label>
          <Input
            id="publicEmail"
            name="publicEmail"
            type="email"
            defaultValue={publicEmail}
            autoComplete="email"
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="approvedPublicAboutCopy">Short About</Label>
          <textarea
            id="approvedPublicAboutCopy"
            name="approvedPublicAboutCopy"
            rows={5}
            maxLength={MAX_PUBLIC_ABOUT_COPY_LENGTH}
            defaultValue={approvedPublicAboutCopy}
            required
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="A short description homeowners will read on your public site."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="publicServiceAreaLabel">Primary service area</Label>
          <Input
            id="publicServiceAreaLabel"
            name="publicServiceAreaLabel"
            defaultValue={publicServiceAreaLabel}
            required
            placeholder="e.g. Reno, NV"
          />
        </div>

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Saving…" : "Save and continue"}
        </Button>
      </form>

      <form action={skipWebsiteSetupAction}>
        <Button type="submit" variant="outline" className="w-full" disabled={pending}>
          Skip for now
        </Button>
      </form>
    </div>
  );
}
