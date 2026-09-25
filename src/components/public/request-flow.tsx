"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  SMS_CONSENT_PRIVACY_URL,
  SMS_CONSENT_TERMS_URL,
  SMS_OPT_IN_LABEL,
} from "@/lib/customer-messaging/compliance";
import {
  formatStructuredAddress,
  formatStructuredMailingAddress,
  validateStructuredAddress,
  type StructuredServiceAddress,
} from "@/lib/service-address";
import type { PublicCatalogGroup, PublicCatalogItem } from "@/lib/public-site";
import type { IntakeAnswerMap, PublicIntakeSchemaProjection } from "@/lib/intake-schema";
import { TradeIntakeFields } from "@/components/public/trade-intake-fields";
import {
  CROSS_TRADE_REQUEST_MESSAGE,
  CUSTOM_WORK_TRADE_REQUIRED_MESSAGE,
  selectedCatalogTradeCodes,
} from "@/lib/public-request-trade";
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

type PublicRequestDraft = {
  step: Step;
  name: string;
  email: string;
  phone: string;
  serviceAddress: StructuredServiceAddress;
  notes: string;
  preferredContact: string;
  smsOptIn: boolean;
};

function requestDraftKey(slug: string) {
  return `tbbt-public-request:${slug}`;
}

const STEPS: { id: Step; title: string; caption: string }[] = [
  { id: "details", title: "Project Details", caption: "Address, notes, and photos" },
  { id: "info", title: "Your Information", caption: "How can we reach you?" },
  { id: "review", title: "Review & Submit", caption: "Review and send request" },
];

function SmsOptInField({
  smsOptIn,
  onChange,
}: {
  smsOptIn: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 text-sm leading-6">
      <input
        type="checkbox"
        name="smsOptIn"
        value="true"
        checked={smsOptIn}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 shrink-0"
      />
      <span>
        {SMS_OPT_IN_LABEL}{" "}
        <a href={SMS_CONSENT_TERMS_URL} className="underline" target="_blank" rel="noreferrer">
          Terms
        </a>{" "}
        and{" "}
        <a href={SMS_CONSENT_PRIVACY_URL} className="underline" target="_blank" rel="noreferrer">
          Privacy
        </a>
        .
      </span>
    </label>
  );
}

export function MultiServiceRequestFlow({
  slug,
  businessName,
  items,
  groups,
  initialSelected,
  photosEnabled,
  serviceArea,
  intakeSchemasByTrade = {},
  activeTrades = [],
}: {
  slug: string;
  businessName: string;
  items: PublicCatalogItem[];
  groups: PublicCatalogGroup[];
  initialSelected: SelectedWorkState;
  photosEnabled: boolean;
  serviceArea: BusinessServiceArea;
  intakeSchemasByTrade?: Record<string, PublicIntakeSchemaProjection>;
  activeTrades?: Array<{ code: string; label: string }>;
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
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [photos, setPhotos] = useState<SelectedRequestPhoto[]>([]);
  const [measurements, setMeasurements] = useState<Record<string, MeasurementDraft>>({});
  const [workArea, setWorkArea] = useState<Record<string, WorkAreaDraft>>({});
  const [intakeAnswers, setIntakeAnswers] = useState<IntakeAnswerMap>({});
  const [customTradeCode, setCustomTradeCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [pending, setPending] = useState(false);
  const submissionIdRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `intake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(requestDraftKey(slug));
      if (raw) {
        const draft = JSON.parse(raw) as PublicRequestDraft;
        if (draft.step === "details" || draft.step === "info" || draft.step === "review") {
          setStep(draft.step);
        }
        if (typeof draft.name === "string") setName(draft.name);
        if (typeof draft.email === "string") setEmail(draft.email);
        if (typeof draft.phone === "string") setPhone(draft.phone);
        if (draft.serviceAddress && typeof draft.serviceAddress === "object") {
          setServiceAddress({
            streetAddress: draft.serviceAddress.streetAddress ?? "",
            unit: draft.serviceAddress.unit ?? "",
            city: draft.serviceAddress.city ?? "",
            region: draft.serviceAddress.region ?? serviceArea.region ?? "",
            postalCode: draft.serviceAddress.postalCode ?? "",
          });
        }
        if (typeof draft.notes === "string") setNotes(draft.notes);
        if (typeof draft.preferredContact === "string") setPreferredContact(draft.preferredContact);
        if (typeof draft.smsOptIn === "boolean") setSmsOptIn(draft.smsOptIn);
      }
    } catch {
      // Ignore a corrupted draft and keep the empty form.
    }
    setHydrated(true);
  }, [serviceArea.region, slug]);

  useEffect(() => {
    if (!hydrated || ok) return;
    try {
      const draft: PublicRequestDraft = {
        step,
        name,
        email,
        phone,
        serviceAddress,
        notes,
        preferredContact,
        smsOptIn,
      };
      sessionStorage.setItem(requestDraftKey(slug), JSON.stringify(draft));
    } catch {
      // Private mode can block sessionStorage. The in-memory form still works.
    }
  }, [email, hydrated, name, notes, ok, phone, preferredContact, serviceAddress, slug, smsOptIn, step]);

  const labels = useMemo(
    () => selectedWorkLabels(selected, items),
    [items, selected],
  );
  const catalogEmpty = items.length === 0;
  const hasWork =
    selected.catalogIds.length > 0 || selected.includeOther || catalogEmpty;
  const selectedTradeCodes = useMemo(
    () => selectedCatalogTradeCodes(items, selected.catalogIds),
    [items, selected.catalogIds],
  );
  const mixedTrade = selectedTradeCodes.length > 1;
  const catalogTrade = selectedTradeCodes.length === 1 ? selectedTradeCodes[0] : "";
  const needsCustomTradeChoice =
    selected.catalogIds.length === 0 &&
    (selected.includeOther || catalogEmpty) &&
    activeTrades.length > 1;
  const resolvedTrade =
    catalogTrade ||
    (needsCustomTradeChoice ? customTradeCode : activeTrades[0]?.code ?? "");
  const intakeSchema = resolvedTrade
    ? intakeSchemasByTrade[resolvedTrade] ?? null
    : null;
  const servicesHref = publicServicesPath(slug, selected);
  const chooseServicesHref = publicServicesPath(slug);

  function readDetailsFromForm(form: HTMLFormElement) {
    const data = new FormData(form);
    const nextNotes = String(data.get("description") ?? "");
    const citySelect = String(data.get("citySelect") ?? "");
    const typedCity = String(data.get("city") ?? "");
    const city =
      typedCity && typedCity !== "__other__"
        ? typedCity
        : citySelect && citySelect !== "__other__"
          ? citySelect
          : "";
    const nextAddress = {
      streetAddress: String(data.get("streetAddress") ?? ""),
      unit: String(data.get("unit") ?? ""),
      city,
      region: String(data.get("region") ?? ""),
      postalCode: String(data.get("postalCode") ?? ""),
    };
    setNotes(nextNotes);
    setServiceAddress(nextAddress);
    return { notes: nextNotes, address: nextAddress };
  }

  function goInfo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const details = readDetailsFromForm(event.currentTarget);
    const checked = validateStructuredAddress(details.address, {
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
    if (mixedTrade) {
      setError(CROSS_TRADE_REQUEST_MESSAGE);
      return;
    }
    if (needsCustomTradeChoice && !customTradeCode) {
      setError(CUSTOM_WORK_TRADE_REQUIRED_MESSAGE);
      return;
    }
    if (intakeSchema) {
      for (const field of intakeSchema.fields) {
        if (!field.required) continue;
        if (field.visibleWhen) {
          const actual = intakeAnswers[field.visibleWhen.field];
          if (String(actual ?? "").toLowerCase() !== field.visibleWhen.value.toLowerCase()) {
            continue;
          }
        }
        const raw = intakeAnswers[field.key];
        if (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
          setError(`Please answer: ${field.label}.`);
          return;
        }
      }
    }
    setServiceAddress(checked.address);
    setError(null);
    setStep("info");
  }

  function goReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextName = String(data.get("name") ?? "");
    const nextEmail = String(data.get("email") ?? "");
    const nextPhone = String(data.get("phone") ?? "");
    const nextPreferred = String(data.get("preferredContact") ?? preferredContact);
    setName(nextName);
    setEmail(nextEmail);
    setPhone(nextPhone);
    setPreferredContact(nextPreferred);
    if (!nextName.trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setStep("review");
  }

  async function onSubmit() {
    if (pending) return;
    if (mixedTrade) {
      setError(CROSS_TRADE_REQUEST_MESSAGE);
      return;
    }
    if (needsCustomTradeChoice && !customTradeCode) {
      setError(CUSTOM_WORK_TRADE_REQUIRED_MESSAGE);
      return;
    }
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
    if (intakeSchema) {
      formData.set("intakeAnswers", JSON.stringify(intakeAnswers));
    }
    if (resolvedTrade) {
      formData.set("requestedTradeCode", resolvedTrade);
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
      try {
        const uploaded = await fetch(authorized.uploadUrl, {
          method: authorized.uploadMethod || "PUT",
          headers: authorized.uploadHeaders,
          body: photo.file,
        });
        if (!uploaded.ok) {
          await abortPublicRequestPhotoUpload({ slug, assetId: authorized.assetId });
          formData.append("photos", photo.file);
          continue;
        }
        const finalized = await finalizePublicRequestPhotoUpload({
          slug,
          assetId: authorized.assetId,
        });
        if (!finalized.assetId) {
          await abortPublicRequestPhotoUpload({ slug, assetId: authorized.assetId });
          formData.append("photos", photo.file);
          continue;
        }
        formData.append("photoAssetId", finalized.assetId);
      } catch {
        await abortPublicRequestPhotoUpload({ slug, assetId: authorized.assetId });
        formData.append("photos", photo.file);
      }
    }
    const preference =
      preferredContact === "text"
        ? "Preferred contact: Text"
        : preferredContact === "phone"
          ? "Preferred contact: Phone"
          : "Preferred contact: Email";
    formData.set("description", [notes, preference].filter(Boolean).join("\n\n"));
    if (smsOptIn) {
      formData.set("smsOptIn", "true");
    }
    const quantities = catalogQuantitiesFromState(selected);
    for (const id of selected.catalogIds) {
      formData.append("serviceCatalogItemId", id);
      formData.append("quantity", String(quantities[id] ?? 1));
    }
    if (selected.includeOther || catalogEmpty) {
      formData.set("includeOther", "true");
      formData.set(
        "otherDescription",
        selected.otherDescription.trim() || notes.trim() || "Other work",
      );
      formData.set("otherQuantity", String(selected.otherQuantity || 1));
    }
    if (typeof window !== "undefined") {
      formData.set("landingPagePath", window.location.pathname);
    }
    const result = await submitPublicIntakeForm(submitServiceRequest, slug, formData);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOk(true);
    try {
      sessionStorage.removeItem(requestDraftKey(slug));
    } catch {
      // Ignore storage failures after a successful submit.
    }
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

  if (mixedTrade) {
    return (
      <section>
        <h2 className="text-2xl font-extrabold uppercase">What work do you need?</h2>
        <p className="mt-3 text-muted-foreground">{CROSS_TRADE_REQUEST_MESSAGE}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={chooseServicesHref} className="public-btn public-btn-primary">
            Choose services for one trade
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
        <div className="mt-6">
          <SmsOptInField smsOptIn={smsOptIn} onChange={setSmsOptIn} />
        </div>
      </section>
    );
  }

  if (!hasWork) {
    return (
      <section>
        <h2 className="text-2xl font-extrabold uppercase">What work do you need?</h2>
        <p className="mt-3 text-muted-foreground">No services selected yet.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={chooseServicesHref} className="public-btn public-btn-primary">
            Choose Services
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <Link
            href={`${chooseServicesHref}?other=1`}
            className="public-btn public-btn-outline"
          >
            Describe other work
          </Link>
        </div>
        <div className="mt-6">
          <SmsOptInField smsOptIn={smsOptIn} onChange={setSmsOptIn} />
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xl font-extrabold tracking-wide uppercase">Your Selected Work</h2>
        {labels.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {labels.map((label) => (
              <li key={label} className="font-semibold">
                {label}
              </li>
            ))}
          </ul>
        ) : catalogEmpty ? (
          <p className="mt-3 text-muted-foreground">
            A published service list is not available yet. Describe the work below
            and the business will review it.
          </p>
        ) : null}
        <QuotePricingNote items={items} selected={selected} />
        {catalogEmpty ? null : (
          <Link
            href={servicesHref || `${chooseServicesHref}${selectedWorkQuery(selected)}`}
            className="mt-4 inline-block font-extrabold tracking-wide text-[var(--public-blue)] uppercase"
          >
            Add Another Service →
          </Link>
        )}
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
        <form className="space-y-4" onSubmit={goInfo}>
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
          {needsCustomTradeChoice ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Which type of work is this?</legend>
              <select
                name="requestedTradeCode"
                value={customTradeCode}
                onChange={(event) => {
                  setCustomTradeCode(event.target.value);
                  setIntakeAnswers({});
                }}
                required
                className="h-12 w-full rounded-lg border border-input bg-white px-3 text-base"
              >
                <option value="">Choose a trade</option>
                {activeTrades.map((trade) => (
                  <option key={trade.code} value={trade.code}>
                    {trade.label}
                  </option>
                ))}
              </select>
            </fieldset>
          ) : null}
          {intakeSchema ? (
            <TradeIntakeFields
              schema={intakeSchema}
              answers={intakeAnswers}
              onChange={setIntakeAnswers}
            />
          ) : null}
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
          <SmsOptInField smsOptIn={smsOptIn} onChange={setSmsOptIn} />
          <button type="submit" className="public-btn public-btn-primary w-full">
            Next: Your Information
            <ArrowRight className="size-4" aria-hidden="true" />
          </button>
        </form>
      ) : null}

      {step === "info" ? (
        <form className="space-y-4" onSubmit={goReview}>
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
          <SmsOptInField smsOptIn={smsOptIn} onChange={setSmsOptIn} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" className="public-btn public-btn-outline flex-1" onClick={() => setStep("details")}>
              Back
            </button>
            <button type="submit" className="public-btn public-btn-primary flex-1">
              Next: Review & Submit
              <ArrowRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </form>
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
            <p>Operational texts: {smsOptIn ? "Yes, I opted in" : "Not opted in"}</p>
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
          <SmsOptInField smsOptIn={smsOptIn} onChange={setSmsOptIn} />
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
