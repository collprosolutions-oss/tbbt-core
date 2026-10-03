/**
 * Read-only TBBT Founder production preflight.
 *
 * Classifies what remains before deploying certified Core and launching
 * the Founder Handyman business. It reuses existing configuration
 * checks and never connects to a database. The production probe is a
 * separate opt-in in scripts/founder-production-preflight-db.mjs.
 *
 * Reports presence and state only. Secret values are not returned.
 */
import { isBlobStorageConfigured, isEmailDeliveryConfigured } from "@/lib/settings";
import { getAppUrl, PRODUCTION_APP_ORIGIN } from "@/lib/mail";
import {
  getStripeSecretKey,
  getStripeWebhookSecret,
  isStripePlatformConfigured,
} from "@/lib/payments/config";
import { explainPaymentsGoLive } from "@/lib/payments/go-live";
import { redactStripeText } from "@/lib/payments/stripe-errors";
import { isMailWebhookPath, MAIL_WEBHOOK_PATH } from "@/lib/mail-webhook-path";
import { isStripeWebhookPath, STRIPE_WEBHOOK_PATH } from "@/lib/stripe-webhook-path";
import { getSaasBillingWebhookSecret, getSaasPriceId } from "@/lib/saas-billing/config";
import { resolveSaasBillingReadiness } from "@/lib/saas-billing/readiness";
import { TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT } from "@/lib/saas-billing/founder-price";
import { isBusinessStorageConfigured } from "@/lib/business-storage/config";
import { PRIVATE_DOWNLOAD_URL_TTL_SECONDS } from "@/lib/business-storage/types";
import { R2_BROWSER_UPLOAD_ALLOWED_ORIGINS } from "@/lib/business-storage/r2-cors";
import {
  CUSTOMER_MESSAGING_WEBHOOK_PATH,
  getTwilioAccountSid,
  getTwilioAuthToken,
  getTwilioFromNumber,
  getTwilioMessagingServiceSid,
  isCustomerMessagingWebhookPath,
  isTwilioCustomerMessagingConfigured,
} from "@/lib/customer-messaging/config";
import {
  isTwilioVoiceWebhookConfigured,
  isVoiceWebhookPath,
  VOICE_WEBHOOK_PATH,
} from "@/lib/communications/voice-webhook";
import { isPublicWebsitePath } from "@/lib/public-website-paths";
import { SCHEDULE_CALENDAR_FEED_PATH_PREFIX } from "@/lib/schedule-calendar-subscription/contract";
import { isScheduleCalendarFeedPath } from "@/lib/schedule-calendar-subscription/path";
import {
  isStudioWeeklyReminderCronPath,
  STUDIO_WEEKLY_REMINDER_CRON_PATH,
} from "@/lib/studio-weekly-reminder-cron-path";

export const PREFLIGHT_STATUSES = ["PASS", "MISSING", "BLOCKED", "MANUAL"] as const;
export type FounderPreflightStatus = (typeof PREFLIGHT_STATUSES)[number];

export const PREFLIGHT_STATUS_LABELS: Record<FounderPreflightStatus, string> = {
  PASS: "PASS",
  MISSING: "MISSING/NOT CONFIGURED",
  BLOCKED: "BLOCKED",
  MANUAL: "MANUAL VERIFICATION REQUIRED",
};

export const PREFLIGHT_REQUIREMENTS = ["REQUIRED", "CONDITIONAL", "OPTIONAL"] as const;
export type FounderPreflightRequirement = (typeof PREFLIGHT_REQUIREMENTS)[number];

export const CONVERSION_MIGRATION_NAME = "20260929161500_job_one_conversion_per_estimate";

export const PRODUCTION_READONLY_DATABASE_URL_ENV =
  "TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL";
export const PRODUCTION_READONLY_CONFIRM_ENV = "TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM";
export const PRODUCTION_READONLY_CONFIRM_VALUE = "confirm-readonly";

/**
 * Same predicate as prisma/migrations/20260929161500_job_one_conversion_per_estimate.
 * Root conversion rows only: recurring occurrences, next bookings, and
 * corrective cleans copy estimateId and are excluded.
 */
export const DUPLICATE_ROOT_CONVERSION_PREDICATES = [
  '"estimateId" IS NOT NULL',
  '"recurrenceSourceJobId" IS NULL',
  '"nextBookingSourceJobId" IS NULL',
  '"correctiveCleanSourceJobId" IS NULL',
] as const;

export const DUPLICATE_ROOT_CONVERSION_JOBS_SQL = `
SELECT "estimateId" AS "estimateId",
       COUNT(*)::int AS "duplicateCount",
       array_agg("id" ORDER BY "id") AS "jobIds"
FROM "Job"
WHERE ${DUPLICATE_ROOT_CONVERSION_PREDICATES.join("\n  AND ")}
GROUP BY "estimateId"
HAVING COUNT(*) > 1
`.trim();

export const CERTIFICATION_SCRIPT_NAMES = [
  "test:production-certification",
  "test:p1-migration-and-db-safety",
  "test:p1-customer-boundaries",
  "test:p1-transaction-races",
  "test:p1-timekeeping",
  "test:p1-native-active-membership",
] as const;

export const PREFLIGHT_ENV_KEYS = [
  "DATABASE_URL",
  "TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL",
  "TBBT_FOUNDER_PRODUCTION_READONLY_CONFIRM",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SAAS_WEBHOOK_SECRET",
  "STRIPE_SAAS_PRICE_ID",
  "TBBT_PAYMENTS_ADAPTER",
  "TBBT_SAAS_BILLING_ADAPTER",
  "TBBT_PAYMENTS_FAKE_READY",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_ID",
  "VERCEL_PROJECT_NAME",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "NEXT_PUBLIC_APP_URL",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "EMAIL_FROM",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ENDPOINT",
  "R2_REGION",
  "STORAGE_PUBLIC_BASE_URL",
  "STORAGE_DEFAULT_LIMIT_BYTES",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_MESSAGING_SERVICE_SID",
  "TWILIO_FROM_NUMBER",
  "TBBT_CUSTOMER_MESSAGING_ADAPTER",
  "TBBT_CUSTOMER_MESSAGING_WEBHOOK_SECRET",
  "CRON_SECRET",
  "BLOB_READ_WRITE_TOKEN",
] as const;

export type PreflightEnvKey = (typeof PREFLIGHT_ENV_KEYS)[number];
export type PreflightEnv = Record<PreflightEnvKey, string>;

export const SENSITIVE_ENV_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "TBBT_FOUNDER_PRODUCTION_READONLY_DATABASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_SAAS_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "EMAIL_FROM",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "EXPO_ACCESS_TOKEN",
  "TBBT_CUSTOMER_MESSAGING_WEBHOOK_SECRET",
  "CRON_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "CONNECTION_TOKEN_ENCRYPTION_KEY",
  "GUSTO_CLIENT_ID",
  "GUSTO_CLIENT_SECRET",
  "META_APP_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
] as const;

export type DuplicateConversionGroup = {
  estimateId: string;
  duplicateCount: number;
  jobIds: string[];
};

export type FounderProductionProbe = {
  connectivity: "ok" | "failed";
  failureDetail: string | null;
  duplicateGroups: DuplicateConversionGroup[];
  publishedBusinessCount: number | null;
  businessCount: number | null;
  verifiedDomainCount: number | null;
  unverifiedDomainCount: number | null;
  failedDomainCount: number | null;
  smsAssignedCount: number | null;
};

export type MigrationPlanInput = {
  blocked?: boolean;
  reason: string;
} | null;

export type ProductionProbeDecision =
  | { action: "skip" }
  | { action: "refuse"; detail: string }
  | { action: "connect"; databaseUrl: string };

export type FounderPreflightCheck = {
  id: string;
  category: string;
  title: string;
  status: FounderPreflightStatus;
  requirement: FounderPreflightRequirement;
  blocksLaunch: boolean;
  detail: string;
  evidence?: DuplicateConversionGroup[];
};

export type FounderPreflightReport = {
  readOnly: true;
  checks: FounderPreflightCheck[];
  launchClearance: "CLEAR" | "NOT_CLEAR";
  blockers: FounderPreflightCheck[];
  operatorActions: Array<{ id: string; title: string; detail: string }>;
};

export function snapshotPreflightEnv(
  source: Record<string, string | undefined> = process.env,
): PreflightEnv {
  const env = {} as PreflightEnv;
  for (const key of PREFLIGHT_ENV_KEYS) {
    const value = source[key];
    env[key] = typeof value === "string" ? value.trim() : "";
  }
  return env;
}

export function sensitiveValuesFromEnv(
  source: Record<string, string | undefined>,
): string[] {
  const values: string[] = [];
  for (const key of SENSITIVE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length >= 4) values.push(trimmed);
    }
  }
  return values;
}

export function redactPreflightText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let text = value;
  const secrets = [...sensitiveValues]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    text = text.split(secret).join("[redacted]");
  }
  text = redactStripeText(text);
  text = text.replace(
    /\b(?:postgres|postgresql):\/\/[^\s]+/gi,
    "postgresql://[redacted]",
  );
  text = text.replace(/\bsk_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted]");
  text = text.replace(/\brk_(?:live|test)_[A-Za-z0-9_]+/g, "[redacted]");
  text = text.replace(/\bwhsec_[A-Za-z0-9_]+/g, "[redacted]");
  text = text.replace(/\bre_[A-Za-z0-9_]+/g, "[redacted]");
  return text;
}

export function databaseTargetHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.replace(":", "").toLowerCase();
    if (protocol !== "postgres" && protocol !== "postgresql") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

export function isPostgresDatabaseUrl(value: string): boolean {
  return databaseTargetHost(value) !== null;
}

/**
 * Production database verdict. Both the dedicated URL and the confirmation
 * flag are required. DATABASE_URL and other application URLs are ignored.
 */
export type ProductionReadonlyTarget = {
  authorized: boolean;
  databaseUrl: string;
};

export function resolveProductionReadonlyDatabaseTarget(env: PreflightEnv): ProductionReadonlyTarget {
  const databaseUrl = env[PRODUCTION_READONLY_DATABASE_URL_ENV];
  const confirm = env[PRODUCTION_READONLY_CONFIRM_ENV];
  if (!databaseUrl || confirm !== PRODUCTION_READONLY_CONFIRM_VALUE) {
    return { authorized: false, databaseUrl: "" };
  }
  return { authorized: true, databaseUrl };
}

export function productionDatabaseProbeDecision(env: PreflightEnv): ProductionProbeDecision {
  const target = resolveProductionReadonlyDatabaseTarget(env);
  if (!target.authorized) return { action: "skip" };
  if (!isPostgresDatabaseUrl(target.databaseUrl)) {
    return {
      action: "refuse",
      detail:
        "The explicit read-only production URL is not a postgres URL. It was not opened. The value is omitted.",
    };
  }
  return { action: "connect", databaseUrl: target.databaseUrl };
}

export function conversionMigrationGuardsDuplicates(sql: string): boolean {
  return (
    DUPLICATE_ROOT_CONVERSION_PREDICATES.every((predicate) => sql.includes(predicate)) &&
    sql.includes("HAVING COUNT(*) > 1") &&
    sql.includes("RAISE EXCEPTION")
  );
}

export function normalizeDuplicateGroups(rows: unknown): DuplicateConversionGroup[] {
  if (!Array.isArray(rows)) return [];
  const groups: DuplicateConversionGroup[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const estimateId = typeof record.estimateId === "string" ? record.estimateId : "";
    const duplicateCount = Number(record.duplicateCount);
    const jobIds = parseJobIds(record.jobIds);
    if (!estimateId || !Number.isFinite(duplicateCount) || duplicateCount < 2) continue;
    groups.push({
      estimateId,
      duplicateCount,
      jobIds,
    });
  }
  return groups;
}

function parseJobIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((id) => String(id)).filter((id) => id.length > 0);
  }
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((id) => id.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

export function classifyDuplicateConversionGroups(groups: readonly DuplicateConversionGroup[]): {
  status: "PASS" | "BLOCKED";
  detail: string;
  evidence: DuplicateConversionGroup[];
} {
  if (groups.length === 0) {
    return {
      status: "PASS",
      detail: `No duplicate root conversion jobs. Migration ${CONVERSION_MIGRATION_NAME} can create its unique index. Rows are not modified.`,
      evidence: [],
    };
  }
  const parts = groups.map(
    (group) =>
      `estimate ${group.estimateId} count ${group.duplicateCount} jobs ${group.jobIds.join(", ")}`,
  );
  return {
    status: "BLOCKED",
    detail: `Duplicate root conversion jobs block migration ${CONVERSION_MIGRATION_NAME}. ${parts.join("; ")}. This checker does not repair or delete them.`,
    evidence: groups.map((group) => ({ ...group, jobIds: [...group.jobIds] })),
  };
}

type CheckDraft = {
  id: string;
  category: string;
  title: string;
  status: FounderPreflightStatus;
  requirement: FounderPreflightRequirement;
  detail: string;
  evidence?: DuplicateConversionGroup[];
};

function finalizeCheck(draft: CheckDraft): FounderPreflightCheck {
  const blocksLaunch =
    draft.status === "BLOCKED" ||
    (draft.requirement === "REQUIRED" && draft.status !== "PASS");
  return { ...draft, blocksLaunch };
}

function stripeKeyClass(value: string): "missing" | "live" | "test" | "restricted" | "unexpected" {
  if (!value) return "missing";
  if (value.startsWith("sk_live_")) return "live";
  if (value.startsWith("sk_test_")) return "test";
  if (value.startsWith("rk_live_") || value.startsWith("rk_test_")) return "restricted";
  return "unexpected";
}

function webhookSecretClass(value: string): "missing" | "present" | "unexpected" {
  if (!value) return "missing";
  if (value.startsWith("whsec_")) return "present";
  return "unexpected";
}

function withPreflightEnv<T>(env: PreflightEnv, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of PREFLIGHT_ENV_KEYS) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (!value) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runtimeDatabaseCheck(env: PreflightEnv): CheckDraft {
  const value = env.DATABASE_URL;
  if (!value) {
    return {
      id: "runtime_database_url",
      category: "database",
      title: "Application database URL",
      status: "MISSING",
      requirement: "REQUIRED",
      detail:
        "DATABASE_URL is not set in this environment. Presence only. This checker never connects with DATABASE_URL and never uses it as the production probe.",
    };
  }
  const host = databaseTargetHost(value);
  if (!host) {
    return {
      id: "runtime_database_url",
      category: "database",
      title: "Application database URL",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail:
        "DATABASE_URL is present but is not a postgres URL. The value is omitted. This checker still does not connect with it.",
    };
  }
  return {
    id: "runtime_database_url",
    category: "database",
    title: "Application database URL",
    status: "PASS",
    requirement: "REQUIRED",
    detail: `DATABASE_URL is present (host ${host}). Credentials are omitted. This value is not used for the production read-only probe.`,
  };
}

function productionProbeCheck(env: PreflightEnv, probe: FounderProductionProbe | null): CheckDraft {
  const decision = productionDatabaseProbeDecision(env);
  if (decision.action === "skip") {
    return {
      id: "production_database_probe",
      category: "database",
      title: "Production database read-only probe",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: `Not run. Set ${PRODUCTION_READONLY_DATABASE_URL_ENV} and ${PRODUCTION_READONLY_CONFIRM_ENV}=${PRODUCTION_READONLY_CONFIRM_VALUE} to open a read-only transaction on that URL only. DATABASE_URL, local databases, and other URLs are not substitutes.`,
    };
  }
  if (decision.action === "refuse") {
    return {
      id: "production_database_probe",
      category: "database",
      title: "Production database read-only probe",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: decision.detail,
    };
  }
  if (!probe || probe.connectivity === "failed") {
    return {
      id: "production_database_probe",
      category: "database",
      title: "Production database read-only probe",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail:
        probe?.failureDetail ||
        "The read-only production probe failed. The URL and credentials are omitted.",
    };
  }
  const host = databaseTargetHost(env[PRODUCTION_READONLY_DATABASE_URL_ENV]);
  return {
    id: "production_database_probe",
    category: "database",
    title: "Production database read-only probe",
    status: "PASS",
    requirement: "REQUIRED",
    detail: `Read-only transaction completed on the explicit production URL${host ? ` (host ${host})` : ""}. Credentials are omitted.`,
  };
}

function duplicateCheck(
  probe: FounderProductionProbe | null,
  decision: ProductionProbeDecision,
): CheckDraft {
  if (decision.action === "skip") {
    return {
      id: "duplicate_root_conversion_jobs",
      category: "migration",
      title: "Duplicate root conversion jobs",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: `Not read. Before migration ${CONVERSION_MIGRATION_NAME}, confirm there is no estimate with more than one Job where estimateId is set and recurrenceSourceJobId, nextBookingSourceJobId, and correctiveCleanSourceJobId are all null. This checker does not repair or delete rows, and it does not substitute another database.`,
    };
  }
  if (decision.action === "refuse" || !probe || probe.connectivity === "failed") {
    return {
      id: "duplicate_root_conversion_jobs",
      category: "migration",
      title: "Duplicate root conversion jobs",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: `The duplicate query did not run. ${probe?.failureDetail || (decision.action === "refuse" ? decision.detail : "The read-only probe failed.")} Rows were not modified.`,
    };
  }
  const classified = classifyDuplicateConversionGroups(probe.duplicateGroups);
  return {
    id: "duplicate_root_conversion_jobs",
    category: "migration",
    title: "Duplicate root conversion jobs",
    status: classified.status,
    requirement: "REQUIRED",
    detail: classified.detail,
    evidence: classified.evidence,
  };
}

function migrationHistoryCheck(
  probe: FounderProductionProbe | null,
  decision: ProductionProbeDecision,
  plan: MigrationPlanInput,
  duplicateStatus: FounderPreflightStatus,
): CheckDraft {
  if (decision.action === "skip") {
    return {
      id: "migration_history",
      category: "migration",
      title: "Migration history",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail:
        "Applied _prisma_migrations history was not read. This checker does not run prisma migrate deploy. Compare local folders with production only through the explicit read-only probe, using the existing migrate plan.",
    };
  }
  if (decision.action === "refuse" || !probe || probe.connectivity === "failed") {
    return {
      id: "migration_history",
      category: "migration",
      title: "Migration history",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "Applied migration history was not read because the read-only probe failed.",
    };
  }
  if (!plan) {
    return {
      id: "migration_history",
      category: "migration",
      title: "Migration history",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: "Read-only rows were available but no migrate plan was supplied. Deploy was not run.",
    };
  }
  const pendingConversion = plan.reason.includes(CONVERSION_MIGRATION_NAME);
  if (plan.blocked) {
    return {
      id: "migration_history",
      category: "migration",
      title: "Migration history",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: `Existing migrate plan blocks deploy: ${plan.reason}. prisma migrate deploy was not run.`,
    };
  }
  if (duplicateStatus === "BLOCKED" && (pendingConversion || plan.reason === "no pending migrations")) {
    return {
      id: "migration_history",
      category: "migration",
      title: "Migration history",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: pendingConversion
        ? `Pending migration ${CONVERSION_MIGRATION_NAME} would fail while duplicate root conversion jobs exist. Do not migrate until those rows are resolved by an operator. This checker will not delete them.`
        : `Duplicate root conversion jobs exist while ${CONVERSION_MIGRATION_NAME} is not pending. The unique index is not protecting those rows. Do not repair them from this checker.`,
    };
  }
  if (duplicateStatus === "MANUAL" && pendingConversion) {
    return {
      id: "migration_history",
      category: "migration",
      title: "Migration history",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: `Migrate plan: ${plan.reason}. The conversion migration is pending and the duplicate gate was not read.`,
    };
  }
  return {
    id: "migration_history",
    category: "migration",
    title: "Migration history",
    status: "PASS",
    requirement: "REQUIRED",
    detail: `Migrate plan: ${plan.reason}. prisma migrate deploy was not run.`,
  };
}

function appUrlCheck(): CheckDraft {
  const appUrl = getAppUrl();
  if (!appUrl) {
    return {
      id: "public_app_url",
      category: "public_url",
      title: "Public app URL",
      status: "MISSING",
      requirement: "REQUIRED",
      detail:
        "getAppUrl() is empty. Set NEXT_PUBLIC_APP_URL to https://www.collproreno.com for the Founder Handyman production origin.",
    };
  }
  if (appUrl === PRODUCTION_APP_ORIGIN) {
    return {
      id: "public_app_url",
      category: "public_url",
      title: "Public app URL",
      status: "PASS",
      requirement: "REQUIRED",
      detail: `Public app URL is ${PRODUCTION_APP_ORIGIN}.`,
    };
  }
  let blocked = "Public app URL is not the Founder Handyman production origin https://www.collproreno.com.";
  try {
    const parsed = new URL(appUrl);
    if (parsed.protocol !== "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      blocked = "Public app URL is not an https production origin. The configured value is omitted.";
    }
  } catch {
    blocked = "Public app URL could not be parsed. The configured value is omitted.";
  }
  return {
    id: "public_app_url",
    category: "public_url",
    title: "Public app URL",
    status: "BLOCKED",
    requirement: "REQUIRED",
    detail: blocked,
  };
}

export function evaluateFounderProductionPreflight(input: {
  env: PreflightEnv;
  conversionMigration?: { present: boolean; guardsDuplicates: boolean } | null;
  certificationScriptsPresent?: Partial<Record<(typeof CERTIFICATION_SCRIPT_NAMES)[number], boolean>> | null;
  migrateOwner?: { run: boolean; reason: string } | null;
  migrationPlan?: MigrationPlanInput;
  probe?: FounderProductionProbe | null;
}): FounderPreflightReport {
  return withPreflightEnv(input.env, () => evaluateInside(input));
}

function evaluateInside(input: {
  env: PreflightEnv;
  conversionMigration?: { present: boolean; guardsDuplicates: boolean } | null;
  certificationScriptsPresent?: Partial<Record<(typeof CERTIFICATION_SCRIPT_NAMES)[number], boolean>> | null;
  migrateOwner?: { run: boolean; reason: string } | null;
  migrationPlan?: MigrationPlanInput;
  probe?: FounderProductionProbe | null;
}): FounderPreflightReport {
  const env = input.env;
  const probe = input.probe ?? null;
  const decision = productionDatabaseProbeDecision(env);
  const fakePayments = env.TBBT_PAYMENTS_ADAPTER === "fake";
  const fakeSaas = env.TBBT_SAAS_BILLING_ADAPTER === "fake";
  const fakeReadyFlag = Boolean(env.TBBT_PAYMENTS_FAKE_READY);
  const fakeMessaging = env.TBBT_CUSTOMER_MESSAGING_ADAPTER === "fake";
  const keyClass = stripeKeyClass(getStripeSecretKey() ?? "");
  const billing = resolveSaasBillingReadiness();
  const appUrl = getAppUrl();
  const platformConfigured = isStripePlatformConfigured();
  const drafts: CheckDraft[] = [];

  drafts.push(runtimeDatabaseCheck(env));
  drafts.push(productionProbeCheck(env, probe));
  const duplicates = duplicateCheck(probe, decision);
  drafts.push(duplicates);
  drafts.push(migrationHistoryCheck(probe, decision, input.migrationPlan ?? null, duplicates.status));

  const migrationFile = input.conversionMigration;
  if (!migrationFile?.present) {
    drafts.push({
      id: "conversion_migration_guard",
      category: "migration",
      title: "Conversion migration file",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: `Migration ${CONVERSION_MIGRATION_NAME} was not found. Deploy was not run.`,
    });
  } else if (!migrationFile.guardsDuplicates) {
    drafts.push({
      id: "conversion_migration_guard",
      category: "migration",
      title: "Conversion migration file",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: `Migration ${CONVERSION_MIGRATION_NAME} does not keep the duplicate-root guard. Deploy was not run.`,
    });
  } else {
    drafts.push({
      id: "conversion_migration_guard",
      category: "migration",
      title: "Conversion migration file",
      status: "PASS",
      requirement: "REQUIRED",
      detail: `Local migration ${CONVERSION_MIGRATION_NAME} refuses to create the unique index when duplicate root conversion jobs exist.`,
    });
  }

  const migrateOwner = input.migrateOwner;
  if (!migrateOwner) {
    drafts.push({
      id: "production_migrate_owner",
      category: "migration",
      title: "Production migrate owner",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail:
        "shouldRunProductionMigrate was not evaluated. This checker does not run prisma migrate deploy.",
    });
  } else if (migrateOwner.run) {
    drafts.push({
      id: "production_migrate_owner",
      category: "migration",
      title: "Production migrate owner",
      status: "PASS",
      requirement: "REQUIRED",
      detail: `This environment is the migrate owner (${migrateOwner.reason}). This checker still does not migrate.`,
    });
  } else if (env.VERCEL_ENV === "production") {
    drafts.push({
      id: "production_migrate_owner",
      category: "migration",
      title: "Production migrate owner",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: `VERCEL_ENV=production would skip prisma migrate deploy (${migrateOwner.reason}).`,
    });
  } else {
    drafts.push({
      id: "production_migrate_owner",
      category: "migration",
      title: "Production migrate owner",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: `This environment would skip prisma migrate deploy (${migrateOwner.reason}). Confirm the collpro-reno production project before relying on build-time migrate.`,
    });
  }

  if (fakePayments || fakeReadyFlag) {
    drafts.push({
      id: "stripe_platform",
      category: "payments",
      title: "Stripe platform secret",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail:
        "TBBT_PAYMENTS_ADAPTER=fake or TBBT_PAYMENTS_FAKE_READY is set. Production must not use the fake payments adapter. The secret value is omitted.",
    });
  } else if (keyClass === "missing") {
    drafts.push({
      id: "stripe_platform",
      category: "payments",
      title: "Stripe platform secret",
      status: "MISSING",
      requirement: "REQUIRED",
      detail: "STRIPE_SECRET_KEY is not set. isStripePlatformConfigured() is false.",
    });
  } else if (keyClass === "test") {
    drafts.push({
      id: "stripe_platform",
      category: "payments",
      title: "Stripe platform secret",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "STRIPE_SECRET_KEY is a test-mode secret. Founder production needs a live platform secret. The value is omitted.",
    });
  } else if (keyClass === "restricted") {
    drafts.push({
      id: "stripe_platform",
      category: "payments",
      title: "Stripe platform secret",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "STRIPE_SECRET_KEY is a restricted key. Founder production needs the live platform secret. The value is omitted.",
    });
  } else if (keyClass === "unexpected") {
    drafts.push({
      id: "stripe_platform",
      category: "payments",
      title: "Stripe platform secret",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "STRIPE_SECRET_KEY is set but is not a live platform secret. The value is omitted.",
    });
  } else {
    drafts.push({
      id: "stripe_platform",
      category: "payments",
      title: "Stripe platform secret",
      status: "PASS",
      requirement: "REQUIRED",
      detail: "A live platform secret is present. The value is omitted. isStripePlatformConfigured() is true.",
    });
  }

  const webhookClass = webhookSecretClass(getStripeWebhookSecret() ?? "");
  const saasWebhook = getSaasBillingWebhookSecret();
  const dedicatedSaasWebhook = env.STRIPE_SAAS_WEBHOOK_SECRET;
  if (webhookClass === "missing" && !dedicatedSaasWebhook) {
    drafts.push({
      id: "stripe_webhook",
      category: "payments",
      title: "Stripe webhook signing secret",
      status: "MISSING",
      requirement: "REQUIRED",
      detail: `No webhook signing secret is set. Production webhook path is ${STRIPE_WEBHOOK_PATH}. The route verifies signatures; this checker does not call Stripe.`,
    });
  } else if (webhookClass === "unexpected" || (dedicatedSaasWebhook && webhookSecretClass(dedicatedSaasWebhook) === "unexpected")) {
    drafts.push({
      id: "stripe_webhook",
      category: "payments",
      title: "Stripe webhook signing secret",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "A webhook signing secret is set but does not use the expected prefix. The value is omitted.",
    });
  } else {
    const shared = !dedicatedSaasWebhook && Boolean(saasWebhook);
    drafts.push({
      id: "stripe_webhook",
      category: "payments",
      title: "Stripe webhook signing secret",
      status: "PASS",
      requirement: "REQUIRED",
      detail: shared
        ? `Webhook signing secret is present. SaaS events reuse it because STRIPE_SAAS_WEBHOOK_SECRET is unset. Path ${STRIPE_WEBHOOK_PATH} is recognized by isStripeWebhookPath. Values are omitted.`
        : `Webhook signing secret is present. Path ${STRIPE_WEBHOOK_PATH} is recognized by isStripeWebhookPath. Values are omitted.`,
    });
  }

  if (fakeSaas || fakePayments) {
    drafts.push({
      id: "saas_billing",
      category: "payments",
      title: "Founder SaaS billing configuration",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail:
        "A fake SaaS or payments adapter is set. resolveSaasBillingReadiness() must not treat that as production Checkout. Values are omitted.",
    });
  } else if (keyClass === "test" || keyClass === "restricted" || keyClass === "unexpected") {
    drafts.push({
      id: "saas_billing",
      category: "payments",
      title: "Founder SaaS billing configuration",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "SaaS billing cannot be production-ready while the platform secret is not a live key. Values are omitted.",
    });
  } else if (billing.reason === "missing_price" || billing.reason === "missing_secret" || billing.reason === "missing_app_url") {
    drafts.push({
      id: "saas_billing",
      category: "payments",
      title: "Founder SaaS billing configuration",
      status: "MISSING",
      requirement: "REQUIRED",
      detail: `resolveSaasBillingReadiness() reason=${billing.reason}. Checkout ready=${String(billing.checkoutReady)}. Portal ready=${String(billing.portalReady)}. Values are omitted.`,
    });
  } else if (billing.reason === "invalid_founder_price") {
    drafts.push({
      id: "saas_billing",
      category: "payments",
      title: "Founder SaaS billing configuration",
      status: "BLOCKED",
      requirement: "REQUIRED",
      detail: "resolveSaasBillingReadiness() rejected the Founder Price. This checker does not call Stripe. Values are omitted.",
    });
  } else {
    drafts.push({
      id: "saas_billing",
      category: "payments",
      title: "Founder SaaS billing configuration",
      status: "PASS",
      requirement: "REQUIRED",
      detail:
        "Live secret, STRIPE_SAAS_PRICE_ID, and app URL satisfy resolveSaasBillingReadiness() configuration. Checkout stays unverified until the Founder Price amount is inspected. This checker does not call Stripe.",
    });
  }

  if (!getSaasPriceId() || fakeSaas) {
    drafts.push({
      id: "founder_price_amount",
      category: "payments",
      title: "Founder Price amount",
      status: fakeSaas ? "BLOCKED" : "MISSING",
      requirement: "REQUIRED",
      detail: fakeSaas
        ? "Fake SaaS billing must not stand in for the live Founder Price."
        : TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT,
    });
  } else {
    drafts.push({
      id: "founder_price_amount",
      category: "payments",
      title: "Founder Price amount",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: `${TBBT_FOUNDER_PRICE_OPERATIONAL_REQUIREMENT} STRIPE_SAAS_PRICE_ID is present. This checker does not call inspectConfiguredFounderPrice() or Stripe. Confirm the live Price is $49 USD/month.`,
    });
  }

  drafts.push(appUrlCheck());

  drafts.push({
    id: "webhook_public_reachability",
    category: "public_url",
    title: "Webhook public reachability",
    status: "MANUAL",
    requirement: "REQUIRED",
    detail: `Confirm Production does not enable Vercel Authentication. Stripe posts to ${PRODUCTION_APP_ORIGIN}${STRIPE_WEBHOOK_PATH}. Twilio SMS callbacks use ${PRODUCTION_APP_ORIGIN}${CUSTOMER_MESSAGING_WEBHOOK_PATH}. Twilio Voice callbacks use ${PRODUCTION_APP_ORIGIN}${VOICE_WEBHOOK_PATH}. Resend bounce and complaint events use ${PRODUCTION_APP_ORIGIN}${MAIL_WEBHOOK_PATH}. Calendar clients GET ${PRODUCTION_APP_ORIGIN}${SCHEDULE_CALENDAR_FEED_PATH_PREFIX}/<token> with no TBBT session. isStripeWebhookPath, isCustomerMessagingWebhookPath, isVoiceWebhookPath, isMailWebhookPath, and isScheduleCalendarFeedPath allow those paths. This checker does not call Vercel.`,
  });

  const storageConfigured = isBusinessStorageConfigured();
  drafts.push({
    id: "r2_platform",
    category: "storage",
    title: "R2 platform storage",
    status: storageConfigured ? "PASS" : "MISSING",
    requirement: "REQUIRED",
    detail: storageConfigured
      ? `isBusinessStorageConfigured() is true. Private objects use presigned GET (${PRIVATE_DOWNLOAD_URL_TTL_SECONDS}s). Public website objects are served by the app under /api/storage/public/, which isPublicWebsitePath allows. Credentials are omitted.`
      : "isBusinessStorageConfigured() is false. Website, intake, and private job-photo uploads need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME. Credentials are omitted.",
  });

  const originAllowed = (R2_BROWSER_UPLOAD_ALLOWED_ORIGINS as readonly string[]).includes(
    PRODUCTION_APP_ORIGIN,
  );
  drafts.push({
    id: "r2_cors",
    category: "storage",
    title: "R2 browser upload CORS",
    status: originAllowed ? "MANUAL" : "BLOCKED",
    requirement: "REQUIRED",
    detail: originAllowed
      ? `Code allows browser upload from ${PRODUCTION_APP_ORIGIN}. Live bucket CORS was not read and was not changed. Confirm the bucket matches r2BrowserUploadCorsRules() before photo upload.`
      : `R2 browser upload allow-list does not include ${PRODUCTION_APP_ORIGIN}. Live CORS was not changed.`,
  });

  const publicBase = env.STORAGE_PUBLIC_BASE_URL;
  if (!publicBase) {
    drafts.push({
      id: "storage_public_base_url",
      category: "storage",
      title: "Optional public storage base URL",
      status: "MISSING",
      requirement: "OPTIONAL",
      detail:
        "STORAGE_PUBLIC_BASE_URL is unset. Public objects still use the app path. Private objects stay on presigned GET. This is not a launch blocker.",
    });
  } else if (!publicBase.startsWith("https://")) {
    drafts.push({
      id: "storage_public_base_url",
      category: "storage",
      title: "Optional public storage base URL",
      status: "BLOCKED",
      requirement: "OPTIONAL",
      detail: "STORAGE_PUBLIC_BASE_URL is set but is not https. The value is omitted.",
    });
  } else {
    drafts.push({
      id: "storage_public_base_url",
      category: "storage",
      title: "Optional public storage base URL",
      status: "PASS",
      requirement: "OPTIONAL",
      detail: "An https STORAGE_PUBLIC_BASE_URL is present. The value is omitted.",
    });
  }

  const emailConfigured = isEmailDeliveryConfigured();
  if (emailConfigured) {
    drafts.push({
      id: "email_provider",
      category: "email",
      title: "Transactional email",
      status: "PASS",
      requirement: "CONDITIONAL",
      detail:
        "isEmailDeliveryConfigured() is true (Resend key, EMAIL_FROM, and app URL). Values are omitted. Unset email stays not-configured; it is not a fake send.",
    });
  } else {
    const missing = [
      env.RESEND_API_KEY ? null : "RESEND_API_KEY",
      env.EMAIL_FROM ? null : "EMAIL_FROM",
      appUrl ? null : "app URL",
    ].filter((item): item is string => Boolean(item));
    const invalidFrom = Boolean(env.EMAIL_FROM) && Boolean(env.RESEND_API_KEY) && Boolean(appUrl);
    drafts.push({
      id: "email_provider",
      category: "email",
      title: "Transactional email",
      status: "MISSING",
      requirement: "CONDITIONAL",
      detail: invalidFrom
        ? "EMAIL_FROM is present but is not a usable address. The value is omitted. Required only if TBBT should send email."
        : `Email delivery is not configured (${missing.join(", ") || "getMailConfig"}). Required only if TBBT should send email. Values are omitted.`,
    });
  }

  const twilioConfigured = isTwilioCustomerMessagingConfigured();
  const messagingService = Boolean(getTwilioMessagingServiceSid());
  const fromNumber = Boolean(getTwilioFromNumber());
  const twilioAccount = Boolean(getTwilioAccountSid() && getTwilioAuthToken());
  if (fakeMessaging) {
    drafts.push({
      id: "sms_twilio",
      category: "sms",
      title: "Twilio SMS",
      status: "BLOCKED",
      requirement: "OPTIONAL",
      detail: "TBBT_CUSTOMER_MESSAGING_ADAPTER=fake must not be set for production. SMS stays optional.",
    });
  } else if (!twilioAccount && !fromNumber && !messagingService) {
    drafts.push({
      id: "sms_twilio",
      category: "sms",
      title: "Twilio SMS",
      status: "MISSING",
      requirement: "OPTIONAL",
      detail:
        "Twilio is not configured. isTwilioCustomerMessagingConfigured() is false. SMS is optional and is not treated as delivered.",
    });
  } else if (twilioConfigured && messagingService) {
    drafts.push({
      id: "sms_twilio",
      category: "sms",
      title: "Twilio SMS",
      status: "PASS",
      requirement: "OPTIONAL",
      detail:
        "Twilio account credentials and a Messaging Service SID are present. TWILIO_FROM_NUMBER is not the multi-tenant sender. Values are omitted.",
    });
  } else if (fromNumber && !messagingService) {
    drafts.push({
      id: "sms_twilio",
      category: "sms",
      title: "Twilio SMS",
      status: "BLOCKED",
      requirement: "OPTIONAL",
      detail:
        "TWILIO_FROM_NUMBER is set without TWILIO_MESSAGING_SERVICE_SID. That number is not a shared multi-tenant sender. Values are omitted.",
    });
  } else {
    drafts.push({
      id: "sms_twilio",
      category: "sms",
      title: "Twilio SMS",
      status: "MISSING",
      requirement: "OPTIONAL",
      detail:
        "Twilio credentials are incomplete. Account SID, auth token, and a Messaging Service SID are required before SMS is configured. Values are omitted.",
    });
  }

  if (!twilioConfigured || fakeMessaging) {
    drafts.push({
      id: "sms_webhook",
      category: "sms",
      title: "Twilio webhook",
      status: fakeMessaging ? "BLOCKED" : "PASS",
      requirement: "OPTIONAL",
      detail: fakeMessaging
        ? "Fake messaging adapter is set, so the Twilio webhook is not a production callback."
        : `SMS is disconnected, so a Twilio status callback is not required. When SMS is enabled the callback is the app origin plus ${CUSTOMER_MESSAGING_WEBHOOK_PATH}, which isCustomerMessagingWebhookPath allows.`,
    });
  } else if (!appUrl) {
    drafts.push({
      id: "sms_webhook",
      category: "sms",
      title: "Twilio webhook",
      status: "BLOCKED",
      requirement: "OPTIONAL",
      detail: "Twilio is configured but getAppUrl() is empty, so the status callback URL cannot be built.",
    });
  } else {
    drafts.push({
      id: "sms_webhook",
      category: "sms",
      title: "Twilio webhook",
      status: "MANUAL",
      requirement: "OPTIONAL",
      detail: `Point the Twilio status callback at ${appUrl}${CUSTOMER_MESSAGING_WEBHOOK_PATH}. The auth proxy allows that path. This checker does not call Twilio.`,
    });
  }

  if (!isTwilioVoiceWebhookConfigured() || fakeMessaging) {
    drafts.push({
      id: "voice_webhook",
      category: "sms",
      title: "Twilio Voice webhook",
      status: fakeMessaging ? "BLOCKED" : "PASS",
      requirement: "OPTIONAL",
      detail: fakeMessaging
        ? "Fake messaging adapter is set, so the Twilio Voice webhook is not a production callback."
        : `Voice answering stays disconnected. A Twilio Voice URL is not required. When Voice callbacks are enabled the path is the app origin plus ${VOICE_WEBHOOK_PATH}, which isVoiceWebhookPath allows.`,
    });
  } else if (!appUrl) {
    drafts.push({
      id: "voice_webhook",
      category: "sms",
      title: "Twilio Voice webhook",
      status: "BLOCKED",
      requirement: "OPTIONAL",
      detail: "Twilio credentials are present but getAppUrl() is empty, so the Voice webhook URL cannot be built.",
    });
  } else {
    drafts.push({
      id: "voice_webhook",
      category: "sms",
      title: "Twilio Voice webhook",
      status: "MANUAL",
      requirement: "OPTIONAL",
      detail: `Point the inbound Voice URL and status callback at ${appUrl}${VOICE_WEBHOOK_PATH}. The route verifies X-Twilio-Signature, logs one missed call per CallSid, and returns TwiML <Reject/>. It does not record or place calls. This checker does not call Twilio.`,
    });
  }

  if (!twilioConfigured || fakeMessaging) {
    drafts.push({
      id: "sms_dedicated_number",
      category: "sms",
      title: "Dedicated business SMS number",
      status: fakeMessaging ? "BLOCKED" : "PASS",
      requirement: "OPTIONAL",
      detail: fakeMessaging
        ? "Fake messaging adapter is set. A dedicated Business.operationalSmsNumber is not a production sender."
        : "SMS is disconnected. Business.operationalSmsNumber is not required.",
    });
  } else if (
    decision.action !== "connect" ||
    !probe ||
    probe.connectivity !== "ok" ||
    probe.smsAssignedCount == null
  ) {
    drafts.push({
      id: "sms_dedicated_number",
      category: "sms",
      title: "Dedicated business SMS number",
      status: "MANUAL",
      requirement: "OPTIONAL",
      detail:
        "Platform Twilio is configured. Confirm each SMS-enabled business has its own Business.operationalSmsNumber. Numbers are not printed. This was not read without the production probe.",
    });
  } else if (probe.smsAssignedCount < 1) {
    drafts.push({
      id: "sms_dedicated_number",
      category: "sms",
      title: "Dedicated business SMS number",
      status: "MISSING",
      requirement: "OPTIONAL",
      detail: "No business has operationalSmsNumber set. Numbers are not printed. SMS can stay off.",
    });
  } else {
    drafts.push({
      id: "sms_dedicated_number",
      category: "sms",
      title: "Dedicated business SMS number",
      status: "PASS",
      requirement: "OPTIONAL",
      detail: `${probe.smsAssignedCount} business record(s) have a dedicated SMS number. The digits are omitted.`,
    });
  }

  drafts.push({
    id: "cron_secret",
    category: "cron",
    title: "Production cron secret",
    status: env.CRON_SECRET ? "PASS" : "MISSING",
    requirement: "REQUIRED",
    detail: env.CRON_SECRET
      ? `CRON_SECRET is present. Value omitted. The studio weekly reminder route fails closed without it. Path ${STUDIO_WEEKLY_REMINDER_CRON_PATH} is recognized by isStudioWeeklyReminderCronPath.`
      : "CRON_SECRET is not set. The production Monday Marketing Studio reminder route fails closed without it.",
  });

  if (!probe || decision.action === "skip") {
    drafts.push({
      id: "website_publish",
      category: "website",
      title: "Website publish state",
      status: "MANUAL",
      requirement: "CONDITIONAL",
      detail:
        "Business.publishedWebsiteId was not read. Publishing is an owner action. Businesses with no publish stay on the live-assembled public path. This checker does not publish.",
    });
  } else if (probe.connectivity !== "ok" || probe.publishedBusinessCount == null) {
    drafts.push({
      id: "website_publish",
      category: "website",
      title: "Website publish state",
      status: "MANUAL",
      requirement: "CONDITIONAL",
      detail: "The read-only probe could not count published websites. Nothing was published by this checker.",
    });
  } else if (probe.publishedBusinessCount < 1) {
    drafts.push({
      id: "website_publish",
      category: "website",
      title: "Website publish state",
      status: "MISSING",
      requirement: "CONDITIONAL",
      detail: `No business has publishedWebsiteId (${probe.businessCount ?? 0} businesses counted). The public site stays on the live-assembled path until an owner publishes.`,
    });
  } else {
    drafts.push({
      id: "website_publish",
      category: "website",
      title: "Website publish state",
      status: "PASS",
      requirement: "CONDITIONAL",
      detail: `${probe.publishedBusinessCount} business record(s) point at a published website snapshot.`,
    });
  }

  if (!probe || decision.action === "skip" || probe.verifiedDomainCount == null) {
    drafts.push({
      id: "custom_domain",
      category: "website",
      title: "Custom / public domain",
      status: "MANUAL",
      requirement: "OPTIONAL",
      detail:
        "WebsiteHostBinding was not read. UNVERIFIED hosts never route. Custom-domain DNS is not automatic. The /hire site still works on the app origin. This checker does not change DNS.",
    });
  } else if (probe.verifiedDomainCount > 0) {
    drafts.push({
      id: "custom_domain",
      category: "website",
      title: "Custom / public domain",
      status: "PASS",
      requirement: "OPTIONAL",
      detail: `${probe.verifiedDomainCount} WebsiteHostBinding row(s) are VERIFIED. Hostnames are omitted.`,
    });
  } else {
    drafts.push({
      id: "custom_domain",
      category: "website",
      title: "Custom / public domain",
      status: "MISSING",
      requirement: "OPTIONAL",
      detail: `No VERIFIED custom host. Unverified ${probe.unverifiedDomainCount ?? 0}, failed ${probe.failedDomainCount ?? 0}. The /hire site does not require a custom domain.`,
    });
  }

  const routesOk =
    isPublicWebsitePath("/") &&
    isPublicWebsitePath("/hire/founder") &&
    isPublicWebsitePath("/r/founder") &&
    isPublicWebsitePath("/api/storage/public/asset") &&
    isStripeWebhookPath(STRIPE_WEBHOOK_PATH) &&
    isCustomerMessagingWebhookPath(CUSTOMER_MESSAGING_WEBHOOK_PATH) &&
    isVoiceWebhookPath(VOICE_WEBHOOK_PATH) &&
    isMailWebhookPath(MAIL_WEBHOOK_PATH) &&
    isStudioWeeklyReminderCronPath(STUDIO_WEEKLY_REMINDER_CRON_PATH) &&
    isScheduleCalendarFeedPath(`${SCHEDULE_CALENDAR_FEED_PATH_PREFIX}/token`);
  drafts.push({
    id: "public_website_routes",
    category: "website",
    title: "Public routes and webhook paths",
    status: routesOk ? "PASS" : "BLOCKED",
    requirement: "REQUIRED",
    detail: routesOk
      ? "Public site, storage, Stripe webhook, Twilio SMS webhook, Twilio Voice webhook, Resend webhook, cron, and calendar-feed paths match the existing allow helpers."
      : "A public, webhook, cron, or calendar-feed path helper no longer matches the production paths.",
  });

  if (fakePayments || keyClass === "test" || keyClass === "restricted" || keyClass === "unexpected") {
    drafts.push({
      id: "stripe_connect_merchant",
      category: "payments",
      title: "Stripe Connect merchant",
      status: "BLOCKED",
      requirement: "CONDITIONAL",
      detail: fakePayments
        ? "Fake payments adapter is set. Connect merchant readiness was not read from Stripe."
        : "Connect checkout needs a live platform secret. The configured secret value is omitted. This checker does not call Stripe.",
    });
  } else if (!platformConfigured || !appUrl) {
    const explanation = explainPaymentsGoLive({
      platformConfigured: platformConfigured && keyClass === "live",
      appUrlConfigured: Boolean(appUrl),
      paymentReady: false,
      status: "not_connected",
    });
    drafts.push({
      id: "stripe_connect_merchant",
      category: "payments",
      title: "Stripe Connect merchant",
      status: "MISSING",
      requirement: "CONDITIONAL",
      detail: `${explanation.detail} Online cards are conditional. This checker does not call Stripe.`,
    });
  } else {
    drafts.push({
      id: "stripe_connect_merchant",
      category: "payments",
      title: "Stripe Connect merchant",
      status: "MANUAL",
      requirement: "CONDITIONAL",
      detail:
        "Platform secret and app URL are present. charges_enabled is retrieved from Stripe at runtime and is not stored. Confirm the Founder Connect account in the Dashboard. This checker does not call Stripe. Manual Mark Paid still works without Connect.",
    });
  }

  const scriptMap = input.certificationScriptsPresent;
  if (!scriptMap) {
    drafts.push({
      id: "certification_commands_present",
      category: "certification",
      title: "Core and P1 certification commands",
      status: "MANUAL",
      requirement: "REQUIRED",
      detail: "package.json scripts were not inspected. This preflight does not run the Core audit.",
    });
  } else {
    const missing = CERTIFICATION_SCRIPT_NAMES.filter((name) => scriptMap[name] !== true);
    drafts.push({
      id: "certification_commands_present",
      category: "certification",
      title: "Core and P1 certification commands",
      status: missing.length === 0 ? "PASS" : "BLOCKED",
      requirement: "REQUIRED",
      detail:
        missing.length === 0
          ? `Present: ${CERTIFICATION_SCRIPT_NAMES.map((name) => `npm run ${name}`).join("; ")}. They were not executed.`
          : `Missing npm scripts: ${missing.join(", ")}.`,
    });
  }

  drafts.push({
    id: "certification_recorded_green",
    category: "certification",
    title: "Recorded Core certification",
    status: "MANUAL",
    requirement: "REQUIRED",
    detail: `Core certification is not re-run here. Before deployment, confirm these commands are still green: ${CERTIFICATION_SCRIPT_NAMES.map((name) => `npm run ${name}`).join("; ")}.`,
  });

  drafts.push({
    id: "blob_legacy",
    category: "storage",
    title: "Legacy blob token",
    status: isBlobStorageConfigured() ? "PASS" : "MISSING",
    requirement: "OPTIONAL",
    detail: isBlobStorageConfigured()
      ? "BLOB_READ_WRITE_TOKEN is present. The value is omitted. New job photos use private R2; blob remains for legacy rows."
      : "BLOB_READ_WRITE_TOKEN is unset. New uploads use R2. Legacy blob URLs stay read-only when the token is absent.",
  });

  const checks = drafts.map((draft) => {
    const sealed = finalizeCheck({
      ...draft,
      detail: redactPreflightText(draft.detail, sensitiveValuesFromEnv(env)),
    });
    return sealed;
  });
  const blockers = checks.filter((item) => item.blocksLaunch);
  const operatorActions = checks
    .filter((item) => item.status !== "PASS")
    .map((item) => ({ id: item.id, title: item.title, detail: item.detail }));
  return {
    readOnly: true,
    checks,
    launchClearance: blockers.length === 0 ? "CLEAR" : "NOT_CLEAR",
    blockers,
    operatorActions,
  };
}

export function formatPreflightReport(
  report: FounderPreflightReport,
  options: { sensitiveValues?: readonly string[] } = {},
): string {
  const lines = [
    "TBBT Founder production preflight",
    "Read-only. No deploy, no migration, no production writes.",
    "",
  ];
  for (const item of report.checks) {
    lines.push(`[${PREFLIGHT_STATUS_LABELS[item.status]}] ${item.title}`);
    lines.push(`  ${item.id} · ${item.requirement}${item.blocksLaunch ? " · blocks launch clearance" : ""}`);
    lines.push(`  ${item.detail}`);
    for (const group of item.evidence ?? []) {
      lines.push(
        `  estimate ${group.estimateId} count ${group.duplicateCount} jobs ${group.jobIds.join(", ")}`,
      );
    }
    lines.push("");
  }
  lines.push(
    report.launchClearance === "CLEAR"
      ? "Launch clearance: CLEAR"
      : "Launch clearance: NOT CLEAR",
  );
  lines.push("");
  lines.push("Operator actions:");
  if (report.operatorActions.length === 0) {
    lines.push("  None.");
  } else {
    for (const action of report.operatorActions) {
      lines.push(`  - ${action.title}: ${action.detail}`);
    }
  }
  return redactPreflightText(lines.join("\n"), options.sensitiveValues ?? []);
}

export function preflightExitCode(report: FounderPreflightReport): number {
  if (report.checks.some((item) => item.status === "BLOCKED")) return 2;
  if (report.launchClearance !== "CLEAR") return 1;
  return 0;
}
