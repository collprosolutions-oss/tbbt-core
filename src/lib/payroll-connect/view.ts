/**
 * Safe payroll-connection projection. Tokens never leave this module.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { CAPABILITIES, roleHasCapability } from "@/lib/authorization";
import type { PayrollConnectAccess } from "@/lib/payroll-connect/access";
import { readGustoAvailability } from "@/lib/payroll-connect/config";
import {
  GUSTO_COMPANY_EXCLUSIVITY_NOTE,
  GUSTO_CONNECTED_HEADLINE,
  GUSTO_DISCONNECTED_HEADLINE,
  GUSTO_DISCONNECT_NOTE,
  GUSTO_FACT_CHANGED_NOTE,
  GUSTO_FACTS_NOTE,
  GUSTO_NEEDS_RECONNECT_HEADLINE,
  GUSTO_NOT_AVAILABLE_HEADLINE,
  GUSTO_NOT_CONNECTED_HEADLINE,
  GUSTO_PARTNER_NOTE,
  GUSTO_PROVIDER,
  GUSTO_REQUIRED_ENV_NAMES,
  GUSTO_RUN_OVERLAP_NOTE,
} from "@/lib/payroll-connect/copy";
import {
  ensurePayrollConnectSchema,
  isRequestPathSchemaUnavailableError,
} from "@/lib/payroll-connect/schema";

type Db = PrismaClient | Prisma.TransactionClient;

export type PayrollConnectFactLineView = {
  providerEmployeeId: string | null;
  employeeName: string | null;
  grossLabel: string;
};

export type PayrollConnectFactView = {
  id: string;
  providerPayrollId: string;
  payPeriodStart: string | null;
  payPeriodEnd: string | null;
  checkDate: string | null;
  processed: true;
  grossLabel: string;
  employerTaxesLabel: string;
  employerBenefitsLabel: string;
  reviewStatus: "UNREVIEWED" | "ACCEPTED" | "IGNORED";
  changeNote: string | null;
  lines: PayrollConnectFactLineView[];
  recordedPayrollRuns: Array<{ id: string; label: string }>;
};

export type PayrollConnectView = {
  provider: typeof GUSTO_PROVIDER;
  phase: "NOT_AVAILABLE" | "NOT_CONNECTED" | "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED" | "OWNER_ONLY";
  headline: string;
  detail: string;
  requiredEnv: readonly string[];
  missingEnv: string[];
  partnerNote: string;
  factsNote: string;
  disconnectNote: string;
  companyExclusivityNote: string;
  overlapNote: string;
  showConnectButton: boolean;
  canSync: boolean;
  canDisconnect: boolean;
  canReview: boolean;
  externalCompanyId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  accessTokenExpired: boolean;
  facts: PayrollConnectFactView[];
};

function formatReportedCents(cents: number | null) {
  if (cents == null) return "Not reported";
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100).toLocaleString("en-US");
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

function iso(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function lockedView(): PayrollConnectView {
  return {
    provider: GUSTO_PROVIDER,
    phase: "OWNER_ONLY",
    headline: "Owner only",
    detail: "Only an owner can connect a payroll provider or review imported facts.",
    requiredEnv: GUSTO_REQUIRED_ENV_NAMES,
    missingEnv: [],
    partnerNote: GUSTO_PARTNER_NOTE,
    factsNote: GUSTO_FACTS_NOTE,
    disconnectNote: GUSTO_DISCONNECT_NOTE,
    companyExclusivityNote: GUSTO_COMPANY_EXCLUSIVITY_NOTE,
    overlapNote: GUSTO_RUN_OVERLAP_NOTE,
    showConnectButton: false,
    canSync: false,
    canDisconnect: false,
    canReview: false,
    externalCompanyId: null,
    lastSyncedAt: null,
    lastError: null,
    accessTokenExpired: false,
    facts: [],
  };
}

export async function loadPayrollConnectView(db: Db, access: PayrollConnectAccess): Promise<PayrollConnectView> {
  if (!roleHasCapability(access.workspace.role, CAPABILITIES.CONNECT_PAYROLL_PROVIDER)) {
    return lockedView();
  }
  await ensurePayrollConnectSchema(db);
  const availability = readGustoAvailability();
  const businessId = access.scope.businessId;
  const connection = await db.payrollConnection.findFirst({
    where: { businessId, provider: GUSTO_PROVIDER },
    select: {
      id: true,
      businessId: true,
      status: true,
      externalCompanyId: true,
      lastSyncedAt: true,
      lastError: true,
      accessTokenExpiresAt: true,
      disconnectedAt: true,
    },
  });
  if (connection) access.assertOwned(connection);

  if (!availability.available) {
    return {
      ...lockedView(),
      phase: "NOT_AVAILABLE",
      headline: GUSTO_NOT_AVAILABLE_HEADLINE,
      detail: `${GUSTO_PARTNER_NOTE} Required environment variables: ${GUSTO_REQUIRED_ENV_NAMES.join(", ")}.`,
      missingEnv: availability.missing,
      showConnectButton: false,
      canSync: false,
      canDisconnect: false,
      canReview: false,
    };
  }

  const status = connection?.status ?? "NONE";
  const phase =
    status === "CONNECTED"
      ? "CONNECTED"
      : status === "NEEDS_RECONNECT"
        ? "NEEDS_RECONNECT"
        : status === "DISCONNECTED"
          ? "DISCONNECTED"
          : "NOT_CONNECTED";
  const headline =
    phase === "CONNECTED"
      ? GUSTO_CONNECTED_HEADLINE
      : phase === "NEEDS_RECONNECT"
        ? GUSTO_NEEDS_RECONNECT_HEADLINE
        : phase === "DISCONNECTED"
          ? GUSTO_DISCONNECTED_HEADLINE
          : GUSTO_NOT_CONNECTED_HEADLINE;
  const accessTokenExpired = Boolean(
    connection?.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() <= Date.now(),
  );
  const facts = await loadFacts(db, businessId);

  return {
    provider: GUSTO_PROVIDER,
    phase,
    headline,
    detail:
      phase === "CONNECTED"
        ? "Token exchange and token info succeeded. Imported rows stay provider-reported facts."
        : phase === "NEEDS_RECONNECT"
          ? connection?.lastError || GUSTO_NEEDS_RECONNECT_HEADLINE
          : phase === "DISCONNECTED"
            ? "Encrypted tokens were removed. Imported facts are still listed."
            : "Demo or production credentials are configured. Connected appears only after token exchange and token info succeed.",
    requiredEnv: GUSTO_REQUIRED_ENV_NAMES,
    missingEnv: [],
    partnerNote: GUSTO_PARTNER_NOTE,
    factsNote: GUSTO_FACTS_NOTE,
    disconnectNote: GUSTO_DISCONNECT_NOTE,
    companyExclusivityNote: GUSTO_COMPANY_EXCLUSIVITY_NOTE,
    overlapNote: GUSTO_RUN_OVERLAP_NOTE,
    showConnectButton: phase !== "CONNECTED",
    canSync: phase === "CONNECTED",
    canDisconnect: phase === "CONNECTED" || phase === "NEEDS_RECONNECT",
    canReview: true,
    externalCompanyId: connection?.externalCompanyId ?? null,
    lastSyncedAt: connection?.lastSyncedAt ? connection.lastSyncedAt.toISOString() : null,
    lastError: connection?.lastError ?? null,
    accessTokenExpired,
    facts,
  };
}

async function loadFacts(db: Db, businessId: string): Promise<PayrollConnectFactView[]> {
  const rows = await db.payrollProviderPayrollFact.findMany({
    where: { businessId, provider: GUSTO_PROVIDER },
    orderBy: [{ checkDate: "desc" }, { providerPayrollId: "asc" }],
    include: { lines: { orderBy: { createdAt: "asc" } } },
  });
  const views: PayrollConnectFactView[] = [];
  for (const row of rows) {
    if (row.businessId !== businessId) continue;
    const recordedPayrollRuns =
      row.payPeriodStart && row.payPeriodEnd
        ? await db.payrollRun.findMany({
            where: {
              businessId,
              payPeriodStart: { lte: row.payPeriodEnd },
              payPeriodEnd: { gte: row.payPeriodStart },
            },
            select: { id: true, status: true, payPeriodStart: true, payPeriodEnd: true },
            take: 3,
          })
        : [];
    const reviewStatus =
      row.reviewStatus === "ACCEPTED" || row.reviewStatus === "IGNORED" ? row.reviewStatus : "UNREVIEWED";
    views.push({
      id: row.id,
      providerPayrollId: row.providerPayrollId,
      payPeriodStart: iso(row.payPeriodStart),
      payPeriodEnd: iso(row.payPeriodEnd),
      checkDate: iso(row.checkDate),
      processed: true,
      grossLabel: formatReportedCents(row.grossTotalCents),
      employerTaxesLabel: formatReportedCents(row.employerTaxesCents),
      employerBenefitsLabel: formatReportedCents(row.employerBenefitsCents),
      reviewStatus,
      changeNote: row.contentChangedAt ? GUSTO_FACT_CHANGED_NOTE : null,
      lines: row.lines
        .filter((line) => line.businessId === businessId)
        .map((line) => ({
          providerEmployeeId: line.providerEmployeeId,
          employeeName: line.employeeName,
          grossLabel: formatReportedCents(line.grossCents),
        })),
      recordedPayrollRuns: recordedPayrollRuns.map((run) => ({
        id: run.id,
        label: `${iso(run.payPeriodStart)} to ${iso(run.payPeriodEnd)} (${run.status}). ${GUSTO_RUN_OVERLAP_NOTE}`,
      })),
    });
  }
  return views;
}

export async function readGustoGoLiveSnapshot(
  db: Db,
  businessId: string,
): Promise<{
  configured: boolean;
  connectionStatus: "NONE" | "CONNECTED" | "NEEDS_RECONNECT" | "DISCONNECTED";
}> {
  const availability = readGustoAvailability();
  try {
    await ensurePayrollConnectSchema(db);
  } catch (error) {
    if (!isRequestPathSchemaUnavailableError(error)) throw error;
    return {
      configured: availability.available,
      connectionStatus: "NONE" as const,
    };
  }
  const row = await db.payrollConnection.findFirst({
    where: { businessId, provider: GUSTO_PROVIDER },
    select: { status: true },
  });
  const connectionStatus =
    row?.status === "CONNECTED" || row?.status === "NEEDS_RECONNECT" || row?.status === "DISCONNECTED"
      ? row.status
      : "NONE";
  return { configured: availability.available, connectionStatus };
}
