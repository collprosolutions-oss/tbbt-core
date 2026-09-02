"use client";

import { useState, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { submitServiceRequest } from "@/app/actions/intake";
import { OTHER_TASK_LABEL } from "@/lib/service-request-work";

export function PublicContactForm({ slug }: { slug: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  if (ok) {
    return (
      <div className="public-form-card">
        <h2 className="text-2xl font-extrabold uppercase">Message Received</h2>
        <p className="mt-4 text-muted-foreground">
          Your message was sent. The team will follow up.
        </p>
      </div>
    );
  }

  async function onSubmit(formData: FormData) {
    if (pending) return;
    setPending(true);
    setError(null);
    const message = String(formData.get("message") ?? "").trim();
    formData.set("includeOther", "true");
    formData.set("otherDescription", OTHER_TASK_LABEL);
    formData.set("description", message);
    formData.set("address", "");
    const result = await submitServiceRequest(slug, formData);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setOk(true);
  }

  return (
    <form action={onSubmit} className="public-form-card space-y-3 text-[var(--public-ink)]">
      <h2 className="text-2xl font-extrabold uppercase">Send Us A Message</h2>
      <Field label="Full Name *" htmlFor="contact-name">
        <input id="contact-name" name="name" autoComplete="name" required />
      </Field>
      <Field label="Phone Number" htmlFor="contact-phone">
        <input id="contact-phone" name="phone" type="tel" autoComplete="tel" />
      </Field>
      <Field label="Email" htmlFor="contact-email">
        <input id="contact-email" name="email" type="email" autoComplete="email" />
      </Field>
      <Field label="Message" htmlFor="contact-message">
        <textarea id="contact-message" name="message" rows={4} placeholder="How can we help?" />
      </Field>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <button type="submit" className="public-btn public-btn-primary w-full" disabled={pending}>
        {pending ? "Sending…" : "Send Message"}
        <ArrowRight className="size-4" />
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
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-xs font-extrabold tracking-wide uppercase">
        {label}
      </label>
      {children}
    </div>
  );
}
