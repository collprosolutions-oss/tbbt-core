/**
 * Owner-triggered import of processed Gusto payroll facts.
 * Idempotent on (businessId, provider, providerPayrollId).
 * Does not write PayrollRun processed fields, payments, expenses,
 * invoices, or bank matches, and does not derive net pay.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { requirePayrollConnectOwner, type PayrollConnectAccess } from "@/lib/payroll-connect/access";
import { readGustoAvailability } from "@/lib/payroll-connect/config";
import { GUSTO_PROVIDER } from "@/lib/payroll-connect/copy";
import { PayrollConnectError } from "@/lib/payroll-connect/errors";
import { gustoImportDateWindow } from "@/lib/payroll-connect/gusto-http";
import { getPayrollProvider } from "@/lib/payroll-connect/provider";
import { refreshPayrollConnection } from "@/lib/payroll-connect/connection";
import { ensurePayrollConnectSchema } from "@/lib/payroll-connect/schema";
import { decryptConnectionToken } from "@/lib/connection-token-crypto";

type Db = PrismaClient | Prisma.TransactionClient;

function isoDate(value: string | null) {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

export async function importProcessedPayrollFacts(db: PrismaClient, access: PayrollConnectAccess) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  const availability = readGustoAvailability();
  if (!availability.available) throw new PayrollConnectError("NOT_AVAILABLE");
  const businessId = access.scope.businessId;
  const existing = await db.payrollConnection.findFirst({
    where: { businessId, provider: GUSTO_PROVIDER },
  });
  if (!existing) throw new PayrollConnectError("NOT_CONNECTED");
  access.assertOwned(existing);
  if (existing.status !== "CONNECTED" || !existing.externalCompanyId || !existing.accessTokenCiphertext) {
    throw new PayrollConnectError(existing.status === "NEEDS_RECONNECT" ? "NEEDS_RECONNECT" : "NOT_CONNECTED");
  }

  await refreshPayrollConnection(db, access);
  const current = await db.payrollConnection.findFirst({
    where: { id: existing.id, businessId, provider: GUSTO_PROVIDER, status: "CONNECTED" },
  });
  if (!current?.accessTokenCiphertext || !current.externalCompanyId) {
    throw new PayrollConnectError("NEEDS_RECONNECT");
  }
  access.assertOwned(current);
  const accessToken = decryptConnectionToken(GUSTO_PROVIDER, businessId, current.accessTokenCiphertext);
  const window = gustoImportDateWindow();
  let drafts;
  try {
    drafts = await getPayrollProvider().listProcessedPayrolls({
      accessToken,
      companyId: current.externalCompanyId,
      startDate: window.startDate,
      endDate: window.endDate,
    });
  } catch (error) {
    if (error instanceof PayrollConnectError && error.code === "INVALID_GRANT") {
      await db.payrollConnection.updateMany({
        where: { id: current.id, businessId, provider: GUSTO_PROVIDER },
        data: {
          status: "NEEDS_RECONNECT",
          accessTokenCiphertext: null,
          refreshTokenCiphertext: null,
          accessTokenExpiresAt: null,
          lastError: new PayrollConnectError("NEEDS_RECONNECT").message,
        },
      });
      throw new PayrollConnectError("NEEDS_RECONNECT");
    }
    throw error instanceof PayrollConnectError ? error : new PayrollConnectError("PROVIDER");
  }

  let imported = 0;
  for (const draft of drafts) {
    if (!draft.processed) continue;
    await db.$transaction(async (tx) => {
      const fact = await tx.payrollProviderPayrollFact.upsert({
        where: {
          businessId_provider_providerPayrollId: {
            businessId,
            provider: GUSTO_PROVIDER,
            providerPayrollId: draft.providerPayrollId,
          },
        },
        create: {
          businessId,
          provider: GUSTO_PROVIDER,
          providerPayrollId: draft.providerPayrollId,
          payPeriodStart: isoDate(draft.payPeriodStart),
          payPeriodEnd: isoDate(draft.payPeriodEnd),
          checkDate: isoDate(draft.checkDate),
          processed: true,
          grossTotalCents: draft.grossTotalCents,
          employerTaxesCents: draft.employerTaxesCents,
          employerBenefitsCents: draft.employerBenefitsCents,
          reviewStatus: "UNREVIEWED",
          rawPayloadHash: draft.rawPayloadHash,
        },
        update: {
          payPeriodStart: isoDate(draft.payPeriodStart),
          payPeriodEnd: isoDate(draft.payPeriodEnd),
          checkDate: isoDate(draft.checkDate),
          processed: true,
          grossTotalCents: draft.grossTotalCents,
          employerTaxesCents: draft.employerTaxesCents,
          employerBenefitsCents: draft.employerBenefitsCents,
          rawPayloadHash: draft.rawPayloadHash,
        },
      });
      if (fact.businessId !== businessId) throw new PayrollConnectError("PROVIDER");
      await tx.payrollProviderPayrollFactLine.deleteMany({
        where: { factId: fact.id, businessId },
      });
      if (draft.lines.length > 0) {
        await tx.payrollProviderPayrollFactLine.createMany({
          data: draft.lines.map((line) => ({
            businessId,
            factId: fact.id,
            providerEmployeeId: line.providerEmployeeId,
            employeeName: line.employeeName,
            grossCents: line.grossCents,
          })),
        });
      }
    });
    imported += 1;
  }

  await db.payrollConnection.updateMany({
    where: { id: current.id, businessId, provider: GUSTO_PROVIDER },
    data: { lastSyncedAt: new Date(), lastError: null },
  });
  return { imported };
}

export async function reviewPayrollProviderFact(
  db: Db,
  access: PayrollConnectAccess,
  input: { factId: string; reviewStatus: "ACCEPTED" | "IGNORED" },
) {
  requirePayrollConnectOwner(access);
  await ensurePayrollConnectSchema(db);
  if (input.reviewStatus !== "ACCEPTED" && input.reviewStatus !== "IGNORED") {
    throw new PayrollConnectError("PROVIDER");
  }
  const fact = await db.payrollProviderPayrollFact.findFirst({
    where: { id: input.factId, businessId: access.scope.businessId, provider: GUSTO_PROVIDER },
  });
  if (!fact) throw new PayrollConnectError("NOT_CONNECTED");
  access.assertOwned(fact);
  await db.payrollProviderPayrollFact.updateMany({
    where: { id: fact.id, businessId: access.scope.businessId, provider: GUSTO_PROVIDER },
    data: { reviewStatus: input.reviewStatus },
  });
}
