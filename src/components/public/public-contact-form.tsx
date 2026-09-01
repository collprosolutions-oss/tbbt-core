"use client";

import { useState, type ReactNode } from "react";
import { Send } from "lucide-react";
import { submitServiceRequest } from "@/app/actions/intake";
import { OTHER_TASK_LABEL } from "@/lib/service-request-work";
import type { PopularPublicCategory } from "@/lib/public-site";

export function PublicContactForm({
  slug,
  categories,
}: {
  slug: string;
  categories: PopularPublicCategory[];
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  if (ok) {
    return (
      <div className="public-form-card">
        <h2 className="text-2xl font-extrabold tracking-tight uppercase">
          Message Received
        </h2>
        <p className="mt-4 text-base leading-7 text-muted-foreground">
          Your message was sent as a service request. The team will review it
          before preparing an estimate.
        </p>
      </div>
    );
  }

  async function onSubmit(formData: FormData) {
    if (pending) return;
    setPending(true);
    setError(null);
    const serviceNeeded = String(formData.get("serviceNeeded") ?? "").trim();
    const message = String(formData.get("message") ?? "").trim();
    const notes = [serviceNeeded, message].filter(Boolean).join("\n\n");
    formData.set("includeOther", "true");
    formData.set("otherDescription", serviceNeeded || OTHER_TASK_LABEL);
    formData.set("description", notes);
    const result = await submitServiceRequest(slug, formData);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOk(true);
  }

  return (
    <form action={onSubmit} className="public-form-card space-y-4">
      <h2 className="text-2xl font-extrabold tracking-tight uppercase">
        Send Us A Message
      </h2>
      <Field label="Name *" htmlFor="contact-name">
        <input id="contact-name" name="name" autoComplete="name" required className="w-full border px-3" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone" htmlFor="contact-phone">
          <input id="contact-phone" name="phone" type="tel" autoComplete="tel" className="w-full border px-3" />
        </Field>
        <Field label="Email" htmlFor="contact-email">
          <input id="contact-email" name="email" type="email" autoComplete="email" className="w-full border px-3" />
        </Field>
      </div>
      <Field label="Property / service address" htmlFor="contact-address">
        <input
          id="contact-address"
          name="address"
          autoComplete="street-address"
          className="w-full border px-3"
        />
      </Field>
      <Field label="Service needed" htmlFor="contact-service">
        <select id="contact-service" name="serviceNeeded" className="w-full border bg-white px-3">
          <option value={OTHER_TASK_LABEL}>{OTHER_TASK_LABEL}</option>
          {categories.map((category) => (
            <option key={category.category} value={category.category}>
              {category.category}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Message / project details" htmlFor="contact-message">
        <textarea
          id="contact-message"
          name="message"
          rows={5}
          className="w-full border px-3 py-2"
          placeholder="Tell us about the work you need."
        />
      </Field>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button type="submit" className="public-btn public-btn-primary w-full" disabled={pending}>
        {pending ? "Sending…" : "Send Message"}
        <Send className="size-4" aria-hidden="true" />
      </button>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}
