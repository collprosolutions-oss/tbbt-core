"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { submitServiceRequest } from "@/app/actions/intake";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ServiceAddressFields } from "@/components/public/service-address-fields";
import {
  RequestMeasurementFields,
  type MeasurementDraft,
} from "@/components/public/request-measurement-fields";
import {
  RequestWorkAreaFields,
  type WorkAreaDraft,
} from "@/components/public/request-work-area-fields";
import {
  RequestPhotoPicker,
  type SelectedRequestPhoto,
} from "@/components/public/request-photo-picker";
import type { BusinessServiceArea } from "@/lib/business-service-area";
import {
  abortPublicRequestPhotoUpload,
  authorizePublicRequestPhotoUpload,
  finalizePublicRequestPhotoUpload,
} from "@/app/actions/public-request-photos";
import {
  catalogAsksMeasurements,
  formatCustomerMeasurement,
  resolveCatalogIntakeConfig,
  validateCustomerMeasurementInput,
} from "@/lib/catalog-intake";
import {
  WORK_AREA_INTAKE_CLEANUP_OPTIONS,
  WORK_AREA_INTAKE_CLARIFICATION,
  WORK_AREA_INTAKE_HANDLING_OPTIONS,
  WORK_AREA_INTAKE_PROTECTION_OPTIONS,
  validateWorkAreaIntakeAnswer,
  workAreaIntakeOptionLabel,
} from "@/lib/work-area-intake";
import { submitPublicIntakeForm } from "@/lib/public-request-submit";
import { publicServicesPath } from "@/lib/public-site";
import { formatPublicPhoneDisplay } from "@/lib/format";
import {
  formatStructuredAddress,
  formatStructuredMailingAddress,
  validateStructuredAddress,
  type StructuredServiceAddress,
} from "@/lib/service-address";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";
import {
  catalogQuantitiesFromState,
  formatPricingSummaryLines,
  selectedCatalogPricingRows,
  selectedWorkLabels,
  selectedWorkQuery,
  summarizeSelectedWorkPricing,
  type SelectedWorkState,
} from "@/lib/selected-work";

type Step = "details" | "info" | "review";

const STEPS: { id: Step; title: string; caption: string }[] = [
  { id: "details", title: "Project Details", caption: "Address, notes, and photos" },
  { id: "info", title: "Your Information", caption: "How can we reach you?" },
  { id: "review", title: "Review & Submit", caption: "Review and send request" },
];

export function MultiServiceRequestFlow({
  slug,
  businessName,
  items,
  groups,
  initialSelected,
  photosEnabled,
  serviceArea,
}: {
  slug: string;
  businessName: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  initialSelected: SelectedWorkState;
  photosEnabled: boolean;
  serviceArea: BusinessServiceArea;
}) {
  void groups;
  const [step, setStep] = useState<Step>("details");
  const [selected] = useState<SelectedWorkState>(initialSelected);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [serviceAddress, setServiceAddress] = useState<StructuredServiceAddress>({
    streetAddress: "",
    unit: "",
    city: "",
    region: serviceArea.region ?? "",
    postalCode: "",
  });
  const [notes, setNotes] = useState("");
  const [preferredContact, setPreferredContact] = useState("text");
  const [photos, setPhotos] = useState<SelectedRequestPhoto[]>([]);
  const [measurements, setMeasurements] = useState<Record<string, MeasurementDraft>>({});
  const [workArea, setWorkArea] = useState<Record<string, WorkAreaDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [pending, setPending] = useState(false);
  const submissionIdRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `intake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  const labels = useMemo(
    () => selectedWorkLabels(selected, items),
    [items, selected],
  );
  const hasWork = selected.catalogIds.length > 0 || selected.includeOther;
  const servicesHref = publicServicesPath(slug, selected);
  const chooseServicesHref = publicServicesPath(slug);

  function goInfo() {
    const checked = validateStructuredAddress(serviceAddress, {
      country: serviceArea.country,
    });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    for (const id of selected.catalogIds) {
      const item = items.find((row) => row.id === id);
      if (!item) continue;
      const config = resolveCatalogIntakeConfig(item);
      if (!catalogAsksMeasurements(config)) continue;
      const measured = validateCustomerMeasurementInput(config, measurements[id] ?? {});
      if (!measured.ok) {
        setError(measured.error);
        return;
      }
    }
    for (const id of selected.catalogIds) {
      const item = items.find((row) => row.id === id);
      if (!item?.asksWorkAreaIntake) continue;
      const draft = workArea[id] ?? {
        contentsHandling: "",
        contentsProtection: "",
        belongingsCleanup: "",
      };
      const answered = validateWorkAreaIntakeAnswer({
        catalogItemId: id,
        ...draft,
      });
      if (!answered.ok) {
        setError(answered.error);
        return;
      }
    }
    setServiceAddress(checked.address);
    setError(null);
    setStep("info");
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
    try {
    const formData = new FormData();
    formData.set("submissionId", submissionIdRef.current.replace(/[^A-Za-z0-9_-]/g, ""));
    formData.set("name", name);
    formData.set("email", email);
    formData.set("phone", phone);
    formData.set("streetAddress", serviceAddress.streetAddress);
    formData.set("unit", serviceAddress.unit);
    formData.set("city", serviceAddress.city);
    formData.set("region", serviceAddress.region);
    formData.set("postalCode", serviceAddress.postalCode);
    formData.set("address", formatStructuredAddress(serviceAddress));
    for (const id of selected.catalogIds) {
      const item = items.find((row) => row.id === id);
      if (!item) continue;
      const config = resolveCatalogIntakeConfig(item);
      if (!catalogAsksMeasurements(config)) continue;
      const draft = measurements[id] ?? { width: "", height: "", length: "" };
      formData.append(
        "measurement",
        JSON.stringify({
          catalogItemId: id,
          width: draft.width,
          height: draft.height,
          length: draft.length,
          unit: config.unit,
        }),
      );
    }
    for (const id of selected.catalogIds) {
      const item = items.find((row) => row.id === id);
      if (!item?.asksWorkAreaIntake) continue;
      const draft = workArea[id];
      if (!draft) continue;
      formData.append(
        "workArea",
        JSON.stringify({
          catalogItemId: id,
          contentsHandling: draft.contentsHandling,
          contentsProtection: draft.contentsProtection,
          belongingsCleanup: draft.belongingsCleanup,
        }),
      );
    }
    for (const photo of photos) {
      const authorized = await authorizePublicRequestPhotoUpload({
        slug,
        originalFilename: photo.file.name,
        mimeType: photo.mimeType || photo.file.type,
        fileSizeBytes: photo.file.size,
      });
      if (!authorized.assetId || !authorized.uploadUrl) {
        setError(authorized.error || "That photo could not be uploaded.");
        return;
      }
      const uploaded = await fetch(authorized.uploadUrl, {
        method: authorized.uploadMethod || "PUT",
        headers: authorized.uploadHeaders,
        body: photo.file,
      });
      if (!uploaded.ok) {
        await abortPublicRequestPhotoUpload({ slug, assetId: authorized.assetId });
        setError("That photo could not be uploaded.");
        return;
      }
      const finalized = await finalizePublicRequestPhotoUpload({
        slug,
        assetId: authorized.assetId,
      });
      if (!finalized.assetId) {
        await abortPublicRequestPhotoUpload({ slug, assetId: authorized.assetId });
        setError(finalized.error || "That photo could not be saved.");
        return;
      }
      formData.append("photoAssetId", finalized.assetId);
    }
    const preference =
      preferredContact === "text"
        ? "Preferred contact: Text"
        : preferredContact === "phone"
          ? "Preferred contact: Phone"
          : "Preferred contact: Email";
    formData.set("description", [notes, preference].filter(Boolean).join("\n\n"));
    const quantities = catalogQuantitiesFromState(selected);
    for (const id of selected.catalogIds) {
      formData.append("serviceCatalogItemId", id);
      formData.append("quantity", String(quantities[id] ?? 1));
    }
    if (selected.includeOther) {
      formData.set("includeOther", "true");
      formData.set("otherDescription", selected.otherDescription);
      formData.set("otherQuantity", String(selected.otherQuantity || 1));
    }
    const result = await submitPublicIntakeForm(submitServiceRequest, slug, formData);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOk(true);
    } catch {
      setError("This request could not be submitted. Please try again.");
    } finally {
      setPending(false);
    }
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
        <Link href={`/hire/${slug}`} className="public-btn public-btn-primary mt-8">
          Back to the website
        </Link>
      </section>
    );
  }

  if (!hasWork) {
    return (
      <section>
        <h2 className="text-2xl font-extrabold uppercase">What work do you need?</h2>
        <p className="mt-3 text-muted-foreground">No services selected yet.</p>
        <Link href={chooseServicesHref} className="public-btn public-btn-primary mt-6">
          Choose Services
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xl font-extrabold tracking-wide uppercase">Your Selected Work</h2>
        <ul className="mt-3 space-y-2">
          {labels.map((label) => (
            <li key={label} className="font-semibold">
              {label}
            </li>
          ))}
        </ul>
        <QuotePricingNote items={items} selected={selected} />
        <Link
          href={servicesHref || `${chooseServicesHref}${selectedWorkQuery(selected)}`}
          className="mt-4 inline-block font-extrabold tracking-wide text-[var(--public-blue)] uppercase"
        >
          Add Another Service →
        </Link>
      </section>

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

      {step === "details" ? (
        <div className="space-y-4">
          <h2 className="text-2xl font-extrabold tracking-tight uppercase">
            Project Details
          </h2>
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
          <ServiceAddressFields
            value={serviceAddress}
            onChange={setServiceAddress}
            serviceArea={serviceArea}
          />
          <RequestMeasurementFields
            items={items}
            selectedCatalogIds={selected.catalogIds}
            values={measurements}
            onChange={(catalogItemId, next) =>
              setMeasurements((current) => ({ ...current, [catalogItemId]: next }))
            }
          />
          <RequestWorkAreaFields
            items={items}
            selectedCatalogIds={selected.catalogIds}
            values={workArea}
            onChange={(catalogItemId, next) =>
              setWorkArea((current) => ({ ...current, [catalogItemId]: next }))
            }
          />
          {photosEnabled ? (
            <RequestPhotoPicker
              photos={photos}
              onChange={setPhotos}
              businessName={businessName}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Photo upload is not available on this site yet. You can still
              submit your request with a description.
            </p>
          )}
          <button type="button" className="public-btn public-btn-primary w-full" onClick={goInfo}>
            Next: Your Information
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {step === "info" ? (
        <div className="space-y-4">
          <h2 className="text-2xl font-extrabold tracking-tight uppercase">
            Your Information
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
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Preferred contact method</legend>
            <div className="public-contact-method">
              <label className="font-semibold">
                <input
                  type="radio"
                  name="preferredContact"
                  value="text"
                  checked={preferredContact === "text"}
                  onChange={() => setPreferredContact("text")}
                />
                Text (preferred)
              </label>
              <label>
                <input
                  type="radio"
                  name="preferredContact"
                  value="phone"
                  checked={preferredContact === "phone"}
                  onChange={() => setPreferredContact("phone")}
                />
                Phone
              </label>
              <label>
                <input
                  type="radio"
                  name="preferredContact"
                  value="email"
                  checked={preferredContact === "email"}
                  onChange={() => setPreferredContact("email")}
                />
                Email
              </label>
            </div>
          </fieldset>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" className="public-btn public-btn-outline flex-1" onClick={() => setStep("details")}>
              Back
            </button>
            <button type="button" className="public-btn public-btn-primary flex-1" onClick={goReview}>
              Next: Review & Submit
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}

      {step === "review" ? (
        <div className="space-y-5">
          <h2 className="text-2xl font-extrabold tracking-tight uppercase">
            Review & Submit
          </h2>
          <ReviewBlock title="Selected services / tasks">
            <ul className="list-disc space-y-1 pl-5">
              {labels.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </ReviewBlock>
          <ReviewBlock title="Contact">
            <p>{name || "—"}</p>
            <p>
              {formatPublicPhoneDisplay(phone) ||
                phone ||
                "No phone provided"}
            </p>
            <p>{email || "No email provided"}</p>
            <p>Preferred: {preferredContact === "text" ? "Text" : preferredContact === "phone" ? "Phone" : "Email"}</p>
          </ReviewBlock>
          <ReviewBlock title="Property">
            <p className="whitespace-pre-line">
              {formatStructuredMailingAddress(serviceAddress) ||
                "No address provided"}
            </p>
          </ReviewBlock>
          <ReviewBlock title="Project notes">
            <p>{notes || "No additional notes"}</p>
          </ReviewBlock>
          <ReviewMeasurementSummary items={items} selectedCatalogIds={selected.catalogIds} measurements={measurements} />
          <ReviewWorkAreaSummary items={items} selectedCatalogIds={selected.catalogIds} workArea={workArea} />
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
              onClick={() => setStep("info")}
            >
              Back / Edit
            </button>
            <button
              type="button"
              className="public-btn public-btn-primary flex-1"
              disabled={pending}
              onClick={onSubmit}
            >
              {pending ? "Submitting…" : "Submit Request"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QuotePricingNote({
  items,
  selected,
}: {
  items: PublicCatalogItem[];
  selected: SelectedWorkState;
}) {
  const lines = formatPricingSummaryLines(
    summarizeSelectedWorkPricing(selectedCatalogPricingRows(selected, items)),
  );
  if (lines.length === 0) return null;
  return (
    <div className="public-estimate-summary mt-4">
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <p className="public-estimate-note">
        Not a formal estimate. The owner reviews the request before sending a written estimate.
      </p>
    </div>
  );
}

function ReviewMeasurementSummary({
  items,
  selectedCatalogIds,
  measurements,
}: {
  items: PublicCatalogItem[];
  selectedCatalogIds: string[];
  measurements: Record<string, MeasurementDraft>;
}) {
  const rows = selectedCatalogIds.flatMap((id) => {
    const item = items.find((row) => row.id === id);
    if (!item) return [];
    const config = resolveCatalogIntakeConfig(item);
    if (!catalogAsksMeasurements(config)) return [];
    const draft = measurements[id] ?? { width: "", height: "", length: "" };
    const label = formatCustomerMeasurement({
      width: draft.width ? Number(draft.width) : null,
      height: draft.height ? Number(draft.height) : null,
      length: draft.length ? Number(draft.length) : null,
      unit: config.unit,
    });
    return [`${item.name}: ${label || "Not provided"}`];
  });
  if (rows.length === 0) return null;
  return (
    <ReviewBlock title="Approximate measurements">
      <ul className="list-disc space-y-1 pl-5">
        {rows.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
    </ReviewBlock>
  );
}

function ReviewWorkAreaSummary({
  items,
  selectedCatalogIds,
  workArea,
}: {
  items: PublicCatalogItem[];
  selectedCatalogIds: string[];
  workArea: Record<string, WorkAreaDraft>;
}) {
  const rows = selectedCatalogIds.flatMap((id) => {
    const item = items.find((row) => row.id === id);
    if (!item?.asksWorkAreaIntake) return [];
    const draft = workArea[id];
    if (!draft) return [];
    return [
      {
        name: item.name,
        handling: workAreaIntakeOptionLabel(
          WORK_AREA_INTAKE_HANDLING_OPTIONS,
          draft.contentsHandling,
        ),
        protection: workAreaIntakeOptionLabel(
          WORK_AREA_INTAKE_PROTECTION_OPTIONS,
          draft.contentsProtection,
        ),
        cleanup: workAreaIntakeOptionLabel(
          WORK_AREA_INTAKE_CLEANUP_OPTIONS,
          draft.belongingsCleanup,
        ),
      },
    ];
  });
  if (rows.length === 0) return null;
  return (
    <ReviewBlock title="Work area & belongings">
      <ul className="list-disc space-y-2 pl-5">
        {rows.map((row) => (
          <li key={row.name}>
            <p>{row.name}</p>
            <p>Work area / contents: {row.handling}</p>
            <p>Contents protection: {row.protection}</p>
            <p>Additional belongings cleaning: {row.cleanup}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted-foreground">{WORK_AREA_INTAKE_CLARIFICATION}</p>
    </ReviewBlock>
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
