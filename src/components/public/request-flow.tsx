"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { submitServiceRequest } from "@/app/actions/intake";
import {
  ServicePicker,
  selectedWorkLabels,
  type SelectedWorkState,
} from "@/components/public/service-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_INTAKE_PHOTOS } from "@/lib/service-request-work";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";

type Step = "select" | "details" | "review";

const STEPS: { id: Step; title: string; caption: string }[] = [
  { id: "select", title: "Select Your Work", caption: "Choose one or more tasks" },
  { id: "details", title: "Project Details", caption: "How can we reach you?" },
  { id: "review", title: "Review Request", caption: "Review and send request" },
];

export function MultiServiceRequestFlow({
  slug,
  businessName,
  items,
  groups,
  initialSelected,
  photosEnabled,
}: {
  slug: string;
  businessName: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  initialSelected: SelectedWorkState;
  photosEnabled: boolean;
}) {
  const [step, setStep] = useState<Step>("select");
  const [selected, setSelected] = useState<SelectedWorkState>(initialSelected);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [pending, setPending] = useState(false);

  const labels = useMemo(
    () => selectedWorkLabels(selected, items),
    [items, selected],
  );
  const hasWork = selected.catalogIds.length > 0 || selected.includeOther;

  function goDetails() {
    if (!hasWork) {
      setError("Select at least one service, or describe other work.");
      return;
    }
    setError(null);
    setStep("details");
  }

  function goReview() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setStep("review");
  }

  async function onSubmit() {
    if (pending) return;
    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("name", name);
    formData.set("email", email);
    formData.set("phone", phone);
    formData.set("address", address);
    formData.set("description", notes);
    for (const id of selected.catalogIds) {
      formData.append("serviceCatalogItemId", id);
    }
    if (selected.includeOther) {
      formData.set("includeOther", "true");
      formData.set("otherDescription", selected.otherDescription);
    }
    for (const file of photos) {
      formData.append("photos", file);
    }
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
      <section className="public-form-card">
        <p className="text-sm font-bold tracking-[0.16em] text-[var(--public-blue)] uppercase">
          Submitted
        </p>
        <h2 className="mt-3 text-3xl font-extrabold tracking-tight">
          Thank you. Your request was received.
        </h2>
        <p className="mt-4 text-lg leading-8 text-muted-foreground">
          Your request has been sent to {businessName}. Someone from the team
          will review it before an estimate is created.
        </p>
        <Link
          href={`/hire/${slug}`}
          className="public-btn public-btn-primary mt-8"
        >
          Back to the website
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <ol className="public-step-bar" aria-label="Request steps">
        {STEPS.map((item, index) => (
          <li key={item.id} className="public-step" data-active={step === item.id ? "true" : "false"}>
            <strong>
              {index + 1}. {item.title}
            </strong>
            <span>{item.caption}</span>
          </li>
        ))}
      </ol>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {step === "select" ? (
        <div className="space-y-5">
          <h2 className="text-2xl font-extrabold tracking-tight uppercase">
            1. Select Your Work
          </h2>
          <ServicePicker
            groups={groups}
            items={items}
            selected={selected}
            onChange={setSelected}
            searchId="request-service-search"
          />
          <button type="button" className="public-btn public-btn-primary w-full" onClick={goDetails}>
            Next: Project Details
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {step === "details" ? (
        <div className="space-y-4">
          <h2 className="text-2xl font-extrabold tracking-tight uppercase">
            2. Project Details
          </h2>
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-12 bg-white text-base"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                className="h-12 bg-white text-base"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-12 bg-white text-base"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">Property / service address</Label>
            <Input
              id="address"
              name="address"
              autoComplete="street-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              className="h-12 bg-white text-base"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Project description</Label>
            <textarea
              id="description"
              name="description"
              rows={4}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="w-full rounded-lg border border-input bg-white px-3 py-2 text-base"
              placeholder="Please describe your project in detail..."
            />
          </div>
          {photosEnabled ? (
            <div className="space-y-2">
              <Label htmlFor="photos">Project photos (optional)</Label>
              <p className="text-sm text-muted-foreground">
                Photos can help {businessName} understand the work. You can add up
                to {MAX_INTAKE_PHOTOS} images.
              </p>
              <Input
                id="photos"
                name="photos"
                type="file"
                accept="image/*"
                multiple
                className="h-12 bg-white pt-2"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []).slice(
                    0,
                    MAX_INTAKE_PHOTOS,
                  );
                  setPhotos(files);
                }}
              />
              {photos.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  {photos.length} photo{photos.length === 1 ? "" : "s"} selected
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Photo upload is not available on this site yet. You can still
              submit your request with a description.
            </p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="public-btn public-btn-outline flex-1"
              onClick={() => setStep("select")}
            >
              Back
            </button>
            <button type="button" className="public-btn public-btn-primary flex-1" onClick={goReview}>
              Next: Review Request
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="space-y-5">
          <h2 className="text-2xl font-extrabold tracking-tight uppercase">
            3. Review Request
          </h2>
          <ReviewBlock title="Selected services / tasks">
            {labels.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5">
                {labels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            ) : (
              <p>None selected</p>
            )}
          </ReviewBlock>
          <ReviewBlock title="Contact">
            <p>{name || "—"}</p>
            <p>{phone || "No phone provided"}</p>
            <p>{email || "No email provided"}</p>
          </ReviewBlock>
          <ReviewBlock title="Property">
            <p>{address || "No address provided"}</p>
          </ReviewBlock>
          <ReviewBlock title="Project notes">
            <p>{notes || "No additional notes"}</p>
          </ReviewBlock>
          <ReviewBlock title="Photos">
            <p>
              {photosEnabled
                ? `${photos.length} photo${photos.length === 1 ? "" : "s"} attached`
                : "Photo upload is not available"}
            </p>
          </ReviewBlock>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="public-btn public-btn-outline flex-1"
              onClick={() => setStep("details")}
            >
              Back / Edit
            </button>
            <button
              type="button"
              className="public-btn public-btn-primary flex-1"
              disabled={pending}
              onClick={onSubmit}
            >
              {pending ? "Submitting…" : "Submit request"}
            </button>
          </div>
        </div>
      ) : null}

      <p className="text-base text-muted-foreground">
        Need to start over?{" "}
        <Link href={`/hire/${slug}`} className="font-medium text-[var(--public-blue)] underline-offset-4 hover:underline">
          Back to the website
        </Link>
      </p>
    </div>
  );
}

function ReviewBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-[#f7f9fc] p-5">
      <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="mt-2 text-base leading-7">{children}</div>
    </section>
  );
}
