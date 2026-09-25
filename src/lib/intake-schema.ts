/**
 * Versioned service-intake schemas.
 *
 * A ServiceRequest stores the exact schema key/version (and JSON snapshot)
 * used when the customer submitted. Later trade-config edits must never
 * reinterpret historical answers — read the frozen snapshot or the
 * archived version, never "current" for old rows.
 */

import { DEFAULT_TRADE, isConfiguredTrade, type TradeCode } from "@/lib/trades";

export const INTAKE_FIELD_TYPES = [
  "TEXT",
  "NUMBER",
  "YES_NO",
  "CHOICE",
  "MULTI_CHOICE",
  "DIMENSIONS",
  "COUNTS",
  "PHOTOS",
  "NOTES",
  "FREQUENCY",
  "CONDITIONAL",
] as const;
export type IntakeFieldType = (typeof INTAKE_FIELD_TYPES)[number];

export type IntakeFieldOption = {
  value: string;
  label: string;
};

export type IntakeFieldDefinition = {
  key: string;
  type: IntakeFieldType;
  label: string;
  required?: boolean;
  help?: string;
  options?: IntakeFieldOption[];
  /** When type is CONDITIONAL, show this field only if match.value is selected. */
  visibleWhen?: { field: string; value: string };
  /** Core Handyman surfaces already render these (photos, notes, measurements). */
  render?: "core" | "trade";
};

export type IntakeSchema = {
  key: string;
  version: number;
  tradeCode: TradeCode;
  title: string;
  fields: IntakeFieldDefinition[];
};

export type IntakeAnswerMap = Record<string, unknown>;

export type FrozenIntakeSnapshot = {
  key: string;
  version: number;
  schema: IntakeSchema;
  answers: IntakeAnswerMap;
};

const HANDYMAN_PUBLIC_V1: IntakeSchema = {
  key: "handyman.public",
  version: 1,
  tradeCode: "HANDYMAN",
  title: "Handyman service request",
  fields: [
    {
      key: "selectedWork",
      type: "MULTI_CHOICE",
      label: "Requested work",
      render: "core",
    },
    {
      key: "measurements",
      type: "DIMENSIONS",
      label: "Approximate measurements",
      help: "Asked only when a selected service requires measurements.",
      render: "core",
    },
    {
      key: "photos",
      type: "PHOTOS",
      label: "Project photos",
      render: "core",
    },
    {
      key: "notes",
      type: "NOTES",
      label: "Project notes",
      render: "core",
    },
    {
      key: "frequency",
      type: "FREQUENCY",
      label: "Visit type",
      options: [
        { value: "ONE_TIME", label: "One-time visit" },
        { value: "CUSTOM", label: "Follow-up visits if needed" },
      ],
      render: "trade",
    },
  ],
};

const CLEANING_PUBLIC_V1: IntakeSchema = {
  key: "cleaning.public",
  version: 1,
  tradeCode: "CLEANING",
  title: "Cleaning service request",
  fields: [
    {
      key: "selectedWork",
      type: "MULTI_CHOICE",
      label: "Requested cleaning",
      render: "core",
    },
    {
      key: "bedrooms",
      type: "COUNTS",
      label: "Bedrooms",
      required: true,
      help: "Approximate number of bedrooms to clean.",
      render: "trade",
    },
    {
      key: "bathrooms",
      type: "COUNTS",
      label: "Bathrooms",
      required: true,
      help: "Approximate number of bathrooms to clean.",
      render: "trade",
    },
    {
      key: "homeSize",
      type: "CHOICE",
      label: "Approximate home size",
      required: true,
      options: [
        { value: "UNDER_1000", label: "Under 1,000 sq ft" },
        { value: "1000_1500", label: "1,000–1,500 sq ft" },
        { value: "1500_2000", label: "1,500–2,000 sq ft" },
        { value: "2000_2500", label: "2,000–2,500 sq ft" },
        { value: "OVER_2500", label: "Over 2,500 sq ft" },
      ],
      render: "trade",
    },
    {
      key: "frequency",
      type: "FREQUENCY",
      label: "How often?",
      required: true,
      options: [
        { value: "ONE_TIME", label: "One-time" },
        { value: "WEEKLY", label: "Weekly" },
        { value: "BIWEEKLY", label: "Every two weeks" },
        { value: "MONTHLY", label: "Monthly" },
      ],
      render: "trade",
    },
    {
      key: "addons",
      type: "MULTI_CHOICE",
      label: "Add-ons",
      options: [
        { value: "INSIDE_FRIDGE", label: "Inside fridge" },
        { value: "INSIDE_OVEN", label: "Inside oven" },
        { value: "INTERIOR_WINDOWS", label: "Interior windows" },
        { value: "LAUNDRY", label: "Laundry" },
        { value: "INSIDE_CABINETS", label: "Inside cabinets" },
      ],
      render: "trade",
    },
    {
      key: "pets",
      type: "YES_NO",
      label: "Pets in the home?",
      render: "trade",
    },
    {
      key: "petNotes",
      type: "TEXT",
      label: "Pet notes",
      visibleWhen: { field: "pets", value: "yes" },
      render: "trade",
    },
    {
      key: "accessNotes",
      type: "NOTES",
      label: "Access notes",
      help: "Gate codes stay off ordinary emails. Share only what the team needs.",
      render: "trade",
    },
    {
      key: "photos",
      type: "PHOTOS",
      label: "Photos of the space",
      render: "core",
    },
    {
      key: "notes",
      type: "NOTES",
      label: "Other notes",
      render: "core",
    },
  ],
};

const ARCHIVED_SCHEMAS: IntakeSchema[] = [HANDYMAN_PUBLIC_V1, CLEANING_PUBLIC_V1];

export function currentIntakeSchema(tradeCode: string): IntakeSchema {
  const code = isConfiguredTrade(tradeCode) ? tradeCode : DEFAULT_TRADE;
  if (code === "CLEANING") return CLEANING_PUBLIC_V1;
  return HANDYMAN_PUBLIC_V1;
}

export function archivedIntakeSchema(key: string, version: number): IntakeSchema | null {
  return (
    ARCHIVED_SCHEMAS.find((schema) => schema.key === key && schema.version === version) ??
    null
  );
}

export function resolveRequestIntakeSchema(input: {
  intakeSchemaKey?: string | null;
  intakeSchemaVersion?: number | null;
  intakeSchemaJson?: string | null;
  tradeCode?: string | null;
}): IntakeSchema {
  if (input.intakeSchemaJson) {
    try {
      const parsed = JSON.parse(input.intakeSchemaJson) as IntakeSchema;
      if (parsed && Array.isArray(parsed.fields) && parsed.key) {
        return parsed;
      }
    } catch {
      // Fall through to archived / current. Never invent answers.
    }
  }
  if (input.intakeSchemaKey && input.intakeSchemaVersion != null) {
    const archived = archivedIntakeSchema(input.intakeSchemaKey, input.intakeSchemaVersion);
    if (archived) return archived;
  }
  return currentIntakeSchema(input.tradeCode ?? DEFAULT_TRADE);
}

export function freezeIntakeSchema(schema: IntakeSchema): string {
  return JSON.stringify(schema);
}

export function parseIntakeAnswers(raw: string | null | undefined): IntakeAnswerMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as IntakeAnswerMap;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function composeIntakeSchema(schemas: IntakeSchema[]): IntakeSchema {
  if (schemas.length === 0) return currentIntakeSchema(DEFAULT_TRADE);
  if (schemas.length === 1) return schemas[0];
  const seen = new Set<string>();
  const fields: IntakeFieldDefinition[] = [];
  for (const schema of schemas) {
    for (const field of schema.fields) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  }
  const codes = [...new Set(schemas.map((schema) => schema.tradeCode))];
  return {
    key: `composed.${codes.join("+")}`,
    version: 1,
    tradeCode: codes[0] ?? DEFAULT_TRADE,
    title: schemas.map((schema) => schema.title).join(" + "),
    fields,
  };
}

export function tradeFieldsToRender(schema: IntakeSchema) {
  return schema.fields.filter((field) => field.render !== "core");
}

export function fieldIsVisible(field: IntakeFieldDefinition, answers: IntakeAnswerMap) {
  if (!field.visibleWhen) return true;
  const actual = answers[field.visibleWhen.field];
  const expected = field.visibleWhen.value;
  if (typeof actual === "boolean") {
    return expected === "yes" ? actual === true : actual === false;
  }
  return String(actual ?? "").toLowerCase() === expected.toLowerCase();
}

function asCount(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99) {
    return value;
  }
  if (typeof value === "string" && /^\d{1,2}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

export function validateIntakeAnswers(
  schema: IntakeSchema,
  answers: IntakeAnswerMap,
): { ok: true; answers: IntakeAnswerMap } | { ok: false; error: string } {
  const cleaned: IntakeAnswerMap = {};
  for (const field of schema.fields) {
    if (field.render === "core") continue;
    if (!fieldIsVisible(field, answers)) continue;
    const raw = answers[field.key];
    if (field.required) {
      const missing =
        raw == null ||
        raw === "" ||
        (Array.isArray(raw) && raw.length === 0);
      if (missing) {
        return { ok: false, error: `Please answer: ${field.label}.` };
      }
    }
    if (raw == null || raw === "") continue;
    if (field.type === "COUNTS" || field.type === "NUMBER") {
      const count = asCount(raw);
      if (count == null) {
        return { ok: false, error: `Enter a whole number for ${field.label}.` };
      }
      cleaned[field.key] = count;
      continue;
    }
    if (field.type === "YES_NO") {
      const yes =
        raw === true ||
        raw === "yes" ||
        raw === "true" ||
        raw === "on" ||
        raw === "1";
      cleaned[field.key] = yes ? "yes" : "no";
      continue;
    }
    if (field.type === "CHOICE" || field.type === "FREQUENCY") {
      const value = String(raw);
      if (field.options && !field.options.some((option) => option.value === value)) {
        return { ok: false, error: `Choose a valid option for ${field.label}.` };
      }
      cleaned[field.key] = value;
      continue;
    }
    if (field.type === "MULTI_CHOICE") {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      const picked = values.filter((value) => allowed.size === 0 || allowed.has(value));
      cleaned[field.key] = picked;
      continue;
    }
    if (typeof raw === "string") {
      if (raw.length > 2000) {
        return { ok: false, error: `Please shorten ${field.label}.` };
      }
      cleaned[field.key] = raw.trim();
    }
  }
  return { ok: true, answers: cleaned };
}

export function publicIntakeSchemaProjection(schema: IntakeSchema) {
  return {
    key: schema.key,
    version: schema.version,
    tradeCode: schema.tradeCode,
    title: schema.title,
    fields: tradeFieldsToRender(schema).map((field) => ({
      key: field.key,
      type: field.type,
      label: field.label,
      required: Boolean(field.required),
      help: field.help ?? null,
      options: field.options ?? [],
      visibleWhen: field.visibleWhen ?? null,
    })),
  };
}

export type PublicIntakeSchemaProjection = ReturnType<typeof publicIntakeSchemaProjection>;

export function intakeSchemaFromPublicProjection(
  projection: PublicIntakeSchemaProjection,
): IntakeSchema {
  return {
    key: projection.key,
    version: projection.version,
    tradeCode: isConfiguredTrade(projection.tradeCode)
      ? projection.tradeCode
      : DEFAULT_TRADE,
    title: projection.title,
    fields: projection.fields.map((field) => ({
      key: field.key,
      type: field.type,
      label: field.label,
      required: field.required,
      help: field.help ?? undefined,
      options: field.options,
      visibleWhen: field.visibleWhen ?? undefined,
      render: "trade" as const,
    })),
  };
}
