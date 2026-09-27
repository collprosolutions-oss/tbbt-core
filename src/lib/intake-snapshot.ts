/**
 * Immutable tenant intake snapshots.
 *
 * OWNER-reviewed publishes copy a validated condition draft into a
 * versioned snapshot. Public hire forms read only the current pointer.
 * New ServiceRequest rows freeze that version. Historical Cleaning V1/V2,
 * Handyman V1, and existing requests resolve from their own recorded
 * schema key/version/JSON — never from a later publish.
 *
 * No JavaScript expressions, eval, Function, or client businessId.
 */

import {
  INTAKE_CONDITION_STATUS_PUBLISHED,
  extraQuestionsAsFields,
  evaluateIntakeConditionDocument,
  parseIntakeConditionDocument,
  validatePreviewIntakeAnswers,
  type IntakeConditionDocument,
} from "@/lib/intake-conditionals";
import {
  freezeIntakeSchema,
  validateIntakeAnswers,
  type IntakeAnswerMap,
  type IntakeSchema,
  type PublicIntakeSchemaProjection,
} from "@/lib/intake-schema";
import { DEFAULT_TRADE, isConfiguredTrade, type TradeCode } from "@/lib/trades";

export const TENANT_INTAKE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const TENANT_INTAKE_SNAPSHOT_STATUS_PUBLISHED = "PUBLISHED" as const;
export const MAX_TENANT_INTAKE_SNAPSHOT_CHARS = 96_000;

export function tenantIntakeSchemaKey(baseKey: string) {
  return `tenant.${baseKey}`;
}

export type TenantIntakeSnapshotPayload = {
  schemaVersion: typeof TENANT_INTAKE_SNAPSHOT_SCHEMA_VERSION;
  status: typeof TENANT_INTAKE_SNAPSHOT_STATUS_PUBLISHED;
  tradeCode: TradeCode;
  versionNumber: number;
  baseSchemaKey: string;
  baseSchemaVersion: number;
  baseSchema: IntakeSchema;
  document: IntakeConditionDocument;
  composedSchema: IntakeSchema;
};

export type PublishedIntakeOverlay = {
  snapshotId: string;
  versionNumber: number;
  publishedAt: string | null;
  composedKey: string;
  document: IntakeConditionDocument;
  /** Frozen platform schema recorded at publish time. Never live current. */
  baseSchema: IntakeSchema;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function composePublishedIntakeSchema(
  platform: IntakeSchema,
  document: IntakeConditionDocument,
  versionNumber: number,
): IntakeSchema {
  return {
    key: tenantIntakeSchemaKey(platform.key),
    version: versionNumber,
    tradeCode: platform.tradeCode,
    title: platform.title,
    fields: [...platform.fields, ...extraQuestionsAsFields(document)],
  };
}

export function buildTenantIntakeSnapshotPayload(input: {
  schema: IntakeSchema;
  document: IntakeConditionDocument;
  versionNumber: number;
}): TenantIntakeSnapshotPayload {
  const document: IntakeConditionDocument = {
    ...input.document,
    status: INTAKE_CONDITION_STATUS_PUBLISHED,
    tradeCode: input.schema.tradeCode,
    baseSchemaKey: input.schema.key,
    baseSchemaVersion: input.schema.version,
  };
  return {
    schemaVersion: TENANT_INTAKE_SNAPSHOT_SCHEMA_VERSION,
    status: TENANT_INTAKE_SNAPSHOT_STATUS_PUBLISHED,
    tradeCode: input.schema.tradeCode,
    versionNumber: input.versionNumber,
    baseSchemaKey: input.schema.key,
    baseSchemaVersion: input.schema.version,
    baseSchema: input.schema,
    document,
    composedSchema: composePublishedIntakeSchema(input.schema, document, input.versionNumber),
  };
}

export function serializeTenantIntakeSnapshotPayload(payload: TenantIntakeSnapshotPayload) {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    status: TENANT_INTAKE_SNAPSHOT_STATUS_PUBLISHED,
    tradeCode: payload.tradeCode,
    versionNumber: payload.versionNumber,
    baseSchemaKey: payload.baseSchemaKey,
    baseSchemaVersion: payload.baseSchemaVersion,
    baseSchema: payload.baseSchema,
    document: payload.document,
    composedSchema: payload.composedSchema,
  });
}

export function parseTenantIntakeSnapshotPayload(raw: unknown): TenantIntakeSnapshotPayload | null {
  const record = typeof raw === "string" ? safeJson(raw) : asRecord(raw);
  if (!record) return null;
  if (record.schemaVersion !== TENANT_INTAKE_SNAPSHOT_SCHEMA_VERSION) return null;
  if (record.status !== TENANT_INTAKE_SNAPSHOT_STATUS_PUBLISHED) return null;
  const tradeCode = isConfiguredTrade(String(record.tradeCode ?? ""))
    ? (record.tradeCode as TradeCode)
    : null;
  if (!tradeCode) return null;
  const versionNumber =
    typeof record.versionNumber === "number" && Number.isInteger(record.versionNumber)
      ? record.versionNumber
      : 0;
  if (versionNumber < 1) return null;
  const parsedDocument = parseIntakeConditionDocument(record.document, { allowPublished: true });
  if (!parsedDocument.ok) return null;
  const baseSchema = asIntakeSchema(record.baseSchema);
  const composedSchema = asIntakeSchema(record.composedSchema);
  if (!baseSchema || !composedSchema) return null;
  if (baseSchema.tradeCode !== tradeCode || parsedDocument.document.tradeCode !== tradeCode) {
    return null;
  }
  return {
    schemaVersion: TENANT_INTAKE_SNAPSHOT_SCHEMA_VERSION,
    status: TENANT_INTAKE_SNAPSHOT_STATUS_PUBLISHED,
    tradeCode,
    versionNumber,
    baseSchemaKey: String(record.baseSchemaKey ?? baseSchema.key),
    baseSchemaVersion:
      typeof record.baseSchemaVersion === "number" ? record.baseSchemaVersion : baseSchema.version,
    baseSchema,
    document: {
      ...parsedDocument.document,
      status: INTAKE_CONDITION_STATUS_PUBLISHED,
    },
    composedSchema,
  };
}

function asIntakeSchema(value: unknown): IntakeSchema | null {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.fields) || typeof record.key !== "string") return null;
  const tradeCode = isConfiguredTrade(String(record.tradeCode ?? ""))
    ? (record.tradeCode as TradeCode)
    : DEFAULT_TRADE;
  return {
    key: record.key,
    version: typeof record.version === "number" ? record.version : 1,
    tradeCode,
    title: typeof record.title === "string" ? record.title : record.key,
    fields: record.fields as IntakeSchema["fields"],
  };
}

function safeJson(raw: string): Record<string, unknown> | null {
  if (raw.length > MAX_TENANT_INTAKE_SNAPSHOT_CHARS) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function publishedOverlayFromRow(row: {
  id: string;
  versionNumber: number;
  snapshotJson: string;
  publishedAt?: Date | string | null;
}): PublishedIntakeOverlay | null {
  const payload = parseTenantIntakeSnapshotPayload(row.snapshotJson);
  if (!payload) return null;
  return {
    snapshotId: row.id,
    versionNumber: row.versionNumber,
    publishedAt:
      row.publishedAt instanceof Date
        ? row.publishedAt.toISOString()
        : typeof row.publishedAt === "string"
          ? row.publishedAt
          : null,
    composedKey: payload.composedSchema.key,
    document: payload.document,
    baseSchema: payload.baseSchema,
  };
}

export function overlayPublishedIntakeProjection(
  platform: PublicIntakeSchemaProjection,
  overlay: PublishedIntakeOverlay | null,
  answers: IntakeAnswerMap,
): PublicIntakeSchemaProjection {
  if (!overlay) return platform;
  const states = evaluateIntakeConditionDocument(overlay.document, answers);
  const extra = overlay.document.questions
    .filter((question) => states[question.key]?.visible)
    .map((question) => ({
      key: question.key,
      type: question.type,
      label: question.label,
      required: states[question.key]?.required === true,
      help: question.help ?? null,
      options: question.options ?? [],
      visibleWhen: null,
    }));
  return {
    ...platform,
    key: overlay.composedKey,
    version: overlay.versionNumber,
    fields: [...platform.fields, ...extra],
  };
}

export function validatePublishedIntakeAnswers(
  platform: IntakeSchema,
  overlay: PublishedIntakeOverlay | null,
  answers: IntakeAnswerMap,
) {
  if (!overlay) return validateIntakeAnswers(platform, answers);
  return validatePreviewIntakeAnswers(overlay.baseSchema, overlay.document, answers);
}

export function freezePublishedIntakeSchema(
  platform: IntakeSchema,
  overlay: PublishedIntakeOverlay | null,
) {
  if (!overlay) return { schema: platform, json: freezeIntakeSchema(platform) };
  const schema = composePublishedIntakeSchema(
    overlay.baseSchema,
    overlay.document,
    overlay.versionNumber,
  );
  return { schema, json: freezeIntakeSchema(schema) };
}

export function readReferencedTenantIntakeSnapshotId(value: unknown): {
  provided: boolean;
  snapshotId: string | null;
} {
  if (value == null) return { provided: false, snapshotId: null };
  if (typeof value !== "string") return { provided: true, snapshotId: null };
  const snapshotId = value.trim();
  if (!snapshotId) return { provided: false, snapshotId: null };
  if (snapshotId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(snapshotId)) {
    return { provided: true, snapshotId: null };
  }
  return { provided: true, snapshotId };
}

export function summarizeTenantIntakeSnapshot(payload: TenantIntakeSnapshotPayload) {
  return `Published ${payload.document.questions.length} extra question${
    payload.document.questions.length === 1 ? "" : "s"
  } and ${payload.document.rules.length} rule${
    payload.document.rules.length === 1 ? "" : "s"
  } for ${payload.tradeCode} on ${payload.baseSchemaKey} v${payload.baseSchemaVersion}.`;
}

