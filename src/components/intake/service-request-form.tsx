"use client";

import { useState } from "react";
import { submitServiceRequest } from "@/app/actions/intake";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ServiceRequestForm({ slug }: { slug: string }) {
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    const result = await submitServiceRequest(slug, formData);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOk(true);
  }

  if (ok) {
    return (
      <Alert>
        <AlertDescription>
          Request received. The business will follow up.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" autoComplete="name" required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" name="phone" type="tel" autoComplete="tel" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">Address (optional)</Label>
        <Input id="address" name="address" autoComplete="street-address" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Job description</Label>
        <textarea
          id="description"
          name="description"
          required
          rows={4}
          className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
        />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Submitting…" : "Submit request"}
      </Button>
    </form>
  );
}
