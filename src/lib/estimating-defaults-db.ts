/**
 * Durable business-scoped persistence for estimating defaults.
 *
 * Preview shares Production and skips migrate, so reads/writes first
 * ensure the table exists with CREATE TABLE IF NOT EXISTS. Production
 * migrate deploy is then a no-op for this additive migration.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  isEstimatingWorkspaceId,
  resolveEstimatingWorkspace,
  type EstimatingWorkspaceId,
} from "@/lib/estimate-calculators/estimating-registry";
import type { CalculatorId } from "@/lib/estimate-calculators/types";
import type { TakeoffSnapshot } from "@/lib/material-takeoff/types";
import {
  extractReusableEstimatingDefaults,
  mergeEstimatingDefaultPayloads,
  parseBusinessEstimatingDefaultPayload,
  resolveWorkspaceIdForTakeoff,
  type BusinessEstimatingDefaultPayload,
} from "@/lib/estimating-defaults";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "BusinessEstimatingDefault" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessEstimatingDefault_pkey" PRIMARY KEY ("id")
);
`;

let ensureTablePromise: Promise<void> | null = null;

export async function ensureBusinessEstimatingDefaultTable(
  db: PrismaClient | Prisma.TransactionClient,
) {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await db.$executeRawUnsafe(CREATE_TABLE_SQL);
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessEstimatingDefault_businessId_workspaceId_key" ON "BusinessEstimatingDefault"("businessId", "workspaceId")`,
      );
      await db.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "BusinessEstimatingDefault_businessId_idx" ON "BusinessEstimatingDefault"("businessId")`,
      );
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }
  await ensureTablePromise;
}

export async function loadBusinessEstimatingDefaults(
  db: PrismaClient | Prisma.TransactionClient,
  businessId: string,
  workspaceId: EstimatingWorkspaceId,
): Promise<BusinessEstimatingDefaultPayload | null> {
  if (!businessId || !isEstimatingWorkspaceId(workspaceId)) return null;
  await ensureBusinessEstimatingDefaultTable(db);
  const row = await db.businessEstimatingDefault.findUnique({
    where: {
      businessId_workspaceId: { businessId, workspaceId },
    },
    select: { payload: true, businessId: true },
  });
  if (!row || row.businessId !== businessId) return null;
  return parseBusinessEstimatingDefaultPayload(row.payload);
}

export async function saveBusinessEstimatingDefaults(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    workspaceId: EstimatingWorkspaceId;
    payload: BusinessEstimatingDefaultPayload;
    replace?: boolean;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  if (!isEstimatingWorkspaceId(input.workspaceId)) {
    throw estimatingDefaultError("Unknown estimating workspace.");
  }
  const parsed = parseBusinessEstimatingDefaultPayload({
    ...input.payload,
    workspaceId: input.workspaceId,
  });
  if (!parsed) {
    throw estimatingDefaultError("Those estimating defaults could not be saved.");
  }
  await ensureBusinessEstimatingDefaultTable(db);
  const existing = await loadBusinessEstimatingDefaults(
    db,
    access.businessId,
    input.workspaceId,
  );
  const next = input.replace
    ? parsed
    : mergeEstimatingDefaultPayloads(existing, parsed);
  const payload = JSON.stringify(next);
  await db.businessEstimatingDefault.upsert({
    where: {
      businessId_workspaceId: {
        businessId: access.businessId,
        workspaceId: input.workspaceId,
      },
    },
    create: {
      businessId: access.businessId,
      workspaceId: input.workspaceId,
      payload,
    },
    update: { payload },
  });
  return next;
}

export async function saveBusinessEstimatingDefaultsFromTakeoff(
  db: PrismaClient,
  access: BusinessAccess,
  input: {
    workspaceId?: string | null;
    snapshot: TakeoffSnapshot;
    calculatorId?: CalculatorId | null;
    title?: string | null;
  },
) {
  const workspace = resolveWorkspaceIdForTakeoff({
    workspaceId: input.workspaceId,
    snapshot: input.snapshot,
    calculatorId: input.calculatorId,
    title: input.title,
  });
  if (!workspace) {
    throw estimatingDefaultError(
      "Choose an estimating workspace before saving defaults.",
    );
  }
  const payload = extractReusableEstimatingDefaults({
    workspaceId: workspace,
    snapshot: input.snapshot,
    calculatorId: input.calculatorId,
  });
  return saveBusinessEstimatingDefaults(db, access, {
    workspaceId: workspace,
    payload,
  });
}

export async function mergeBusinessCalculatorRateDefaults(
  db: PrismaClient | Prisma.TransactionClient,
  access: BusinessAccess,
  input: {
    calculatorId: CalculatorId;
    title?: string | null;
    rates: Record<string, unknown>;
  },
) {
  const workspace = resolveEstimatingWorkspace({
    calculatorId: input.calculatorId,
    title: input.title,
  });
  if (!workspace) return null;
  const payload = extractReusableEstimatingDefaults({
    workspaceId: workspace.id,
    calculatorId: input.calculatorId,
    calculatorRates: input.rates,
  });
  await ensureBusinessEstimatingDefaultTable(db);
  const existing = await loadBusinessEstimatingDefaults(
    db,
    access.businessId,
    workspace.id,
  );
  const next = mergeEstimatingDefaultPayloads(existing, payload);
  await db.businessEstimatingDefault.upsert({
    where: {
      businessId_workspaceId: {
        businessId: access.businessId,
        workspaceId: workspace.id,
      },
    },
    create: {
      businessId: access.businessId,
      workspaceId: workspace.id,
      payload: JSON.stringify(next),
    },
    update: { payload: JSON.stringify(next) },
  });
  return next;
}

function estimatingDefaultError(message: string) {
  const error = new Error(message);
  error.name = "EstimateLineError";
  return error;
}
