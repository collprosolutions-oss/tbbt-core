/**
 * OWNER-reviewed bank CSV write path.
 *
 * Import stores the exact source bytes and suggested matches against
 * recorded Payment / Expense rows. Accepting a match only records the
 * review link. This module never creates a Payment, never updates an
 * Invoice or Expense, never writes InvoiceCredit, and never marks
 * banking CONNECTED or a verified bank balance.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { resolveBusinessTimeZone } from "@/lib/business-timezone";
import { ACTIVE_EXPENSE_WHERE } from "@/lib/expenses";
import { formatISODate } from "@/lib/schedule";
import {
  BANK_CANDIDATE_ALREADY_ACCEPTED_MESSAGE,
  BANK_IMPORT_NOT_AVAILABLE_MESSAGE,
  BANK_MATCH_ALREADY_DECIDED_MESSAGE,
  BANK_MATCH_NOT_AVAILABLE_MESSAGE,
  BANK_RECONCILIATION_ROUTE,
  BANK_ROW_NOT_REVIEWABLE_MESSAGE,
  BankReconciliationError,
  decodeCsvBytes,
  FILE_TOO_LARGE_MESSAGE,
  hashCsvBytes,
  MAX_BANK_CSV_BYTES,
  OWNER_ONLY_BANK_RECONCILIATION_MESSAGE,
  parseBankCsv,
  sanitizeSourceFilename,
  suggestBankMatches,
  summarizeBankWorkspace,
  workspaceCountsWrite,
  type ParsedBankRow,
} from "@/lib/bank-reconciliation";

export { BANK_RECONCILIATION_ROUTE, OWNER_ONLY_BANK_RECONCILIATION_MESSAGE };

type Db = PrismaClient;
export type BankReconciliationAccess = BusinessAccess;

export type StoredBankMatch = {
  id: string;
  businessId: string;
  importId: string;
  rowId: string;
  candidateKind: string;
  candidateId: string;
  score: number;
  matchReason: string;
  status: string;
  decidedAt: Date | null;
  decidedByMembershipId: string | null;
  candidateLabel: string | null;
  candidateAmount: string | null;
  candidateDate: string | null;
};

export type StoredBankRow = {
  id: string;
  businessId: string;
  importId: string;
  rowNumber: number;
  postedOn: string | null;
  description: string;
  amountCents: number;
  direction: string;
  rowFingerprint: string;
  rawLine: string;
  reviewStatus: string;
  invalidReason: string | null;
  reversalOfRowNumber: number | null;
  duplicateOfRowNumber: number | null;
  matches: StoredBankMatch[];
};

export type BankReconciliationWorkspace = {
  id: string;
  businessId: string;
  sourceKind: string;
  sourceLabel: string;
  contentSha256: string;
  capturedAt: Date;
  status: string;
  rowCount: number;
  depositCount: number;
  withdrawalCount: number;
  unmatchedCount: number;
  candidateMatchCount: number;
  duplicateRowCount: number;
  reversedCount: number;
  invalidCount: number;
  postedDepositCents: number;
  postedWithdrawalCents: number;
  netPostedCents: number;
  acceptedDepositCents: number;
  acceptedWithdrawalCents: number;
  createdByMembershipId: string;
  rows: StoredBankRow[];
};

export type BankReconciliationListItem = {
  id: string;
  sourceLabel: string;
  capturedAt: Date;
  rowCount: number;
  candidateMatchCount: number;
  unmatchedCount: number;
};

export type BankSourceFile = {
  filename: string;
  bytes: Buffer;
};

function requireOwnerReview(access: BankReconciliationAccess) {
  requireBusinessCapability(access, CAPABILITIES.REVIEW_BANK_RECONCILIATION);
}

function membershipId(access: BankReconciliationAccess): string {
  const id = access.workspace.membership?.id?.trim();
  if (!id) {
    throw new BankReconciliationError(OWNER_ONLY_BANK_RECONCILIATION_MESSAGE);
  }
  return id;
}

function rowWriteData(businessId: string, row: ParsedBankRow) {
  return {
    businessId,
    rowNumber: row.rowNumber,
    postedOn: row.postedOn,
    description: row.description,
    amountCents: row.amountCents,
    direction: row.direction,
    rowFingerprint: row.rowFingerprint,
    rawLine: row.rawLine,
    reviewStatus: row.reviewStatus,
    invalidReason: row.invalidReason,
    reversalOfRowNumber: row.reversalOfRowNumber,
    duplicateOfRowNumber: row.duplicateOfRowNumber,
  };
}

function toWorkspace(
  record: {
    id: string;
    businessId: string;
    sourceKind: string;
    sourceLabel: string;
    contentSha256: string;
    capturedAt: Date;
    status: string;
    createdByMembershipId: string;
  },
  rows: StoredBankRow[],
): BankReconciliationWorkspace {
  const totals = summarizeBankWorkspace(
    rows,
    rows.flatMap((row) => row.matches),
  );
  return {
    id: record.id,
    businessId: record.businessId,
    sourceKind: record.sourceKind,
    sourceLabel: record.sourceLabel,
    contentSha256: record.contentSha256,
    capturedAt: record.capturedAt,
    status: record.status,
    createdByMembershipId: record.createdByMembershipId,
    rows,
    ...totals,
  };
}

async function loadCandidateLabels(
  db: Db,
  access: BankReconciliationAccess,
  matches: Array<{ candidateKind: string; candidateId: string }>,
): Promise<
  Map<string, { label: string; amount: string; date: string }>
> {
  const paymentIds = matches
    .filter((match) => match.candidateKind === "PAYMENT")
    .map((match) => match.candidateId);
  const expenseIds = matches
    .filter((match) => match.candidateKind === "EXPENSE")
    .map((match) => match.candidateId);
  const labels = new Map<string, { label: string; amount: string; date: string }>();
  const timeZone = resolveBusinessTimeZone(access.workspace.business);

  if (paymentIds.length > 0) {
    const payments = await db.payment.findMany({
      where: { businessId: access.businessId, id: { in: paymentIds } },
      select: { id: true, amount: true, receivedAt: true, method: true, purpose: true, note: true },
    });
    for (const payment of payments) {
      labels.set(`PAYMENT:${payment.id}`, {
        label: [payment.purpose, payment.method, payment.note].filter(Boolean).join(" · ") || "Payment",
        amount: payment.amount.toFixed(2),
        date: formatISODate(payment.receivedAt, timeZone),
      });
    }
  }
  if (expenseIds.length > 0) {
    const expenses = await db.expense.findMany({
      where: { businessId: access.businessId, id: { in: expenseIds } },
      select: { id: true, amount: true, occurredOn: true, description: true, vendor: true },
    });
    for (const expense of expenses) {
      labels.set(`EXPENSE:${expense.id}`, {
        label: [expense.vendor, expense.description].filter(Boolean).join(" · ") || "Expense",
        amount: expense.amount.toFixed(2),
        date: formatISODate(expense.occurredOn, timeZone),
      });
    }
  }
  return labels;
}

function attachLabels(
  matches: Array<Omit<StoredBankMatch, "candidateLabel" | "candidateAmount" | "candidateDate">>,
  labels: Map<string, { label: string; amount: string; date: string }>,
): StoredBankMatch[] {
  return matches.map((match) => {
    const found = labels.get(`${match.candidateKind}:${match.candidateId}`);
    return {
      ...match,
      candidateLabel: found?.label ?? null,
      candidateAmount: found?.amount ?? null,
      candidateDate: found?.date ?? null,
    };
  });
}

async function loadWorkspaceRecord(
  db: Db,
  access: BankReconciliationAccess,
  importId: string,
) {
  const record = await db.bankReconciliationImport.findFirst({
    where: { id: importId, businessId: access.businessId },
    include: {
      rows: {
        orderBy: { rowNumber: "asc" },
        include: { matches: { orderBy: [{ score: "desc" }, { id: "asc" }] } },
      },
    },
  });
  if (!record) {
    throw new BankReconciliationError(BANK_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(record);
  return record;
}

export async function loadOwnedBankReconciliation(
  db: Db,
  access: BankReconciliationAccess,
  importId: string,
): Promise<BankReconciliationWorkspace> {
  requireOwnerReview(access);
  const id = importId.trim();
  if (!id) {
    throw new BankReconciliationError(BANK_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  const record = await loadWorkspaceRecord(db, access, id);
  const labels = await loadCandidateLabels(
    db,
    access,
    record.rows.flatMap((row) => row.matches),
  );
  const rows: StoredBankRow[] = record.rows.map((row) => ({
    id: row.id,
    businessId: row.businessId,
    importId: row.importId,
    rowNumber: row.rowNumber,
    postedOn: row.postedOn,
    description: row.description,
    amountCents: row.amountCents,
    direction: row.direction,
    rowFingerprint: row.rowFingerprint,
    rawLine: row.rawLine,
    reviewStatus: row.reviewStatus,
    invalidReason: row.invalidReason,
    reversalOfRowNumber: row.reversalOfRowNumber,
    duplicateOfRowNumber: row.duplicateOfRowNumber,
    matches: attachLabels(row.matches, labels),
  }));
  return toWorkspace(record, rows);
}

export async function listOwnedBankReconciliations(
  db: Db,
  access: BankReconciliationAccess,
): Promise<BankReconciliationListItem[]> {
  requireOwnerReview(access);
  const rows = await db.bankReconciliationImport.findMany({
    where: { businessId: access.businessId },
    orderBy: { capturedAt: "desc" },
    take: 20,
    select: {
      id: true,
      businessId: true,
      sourceLabel: true,
      capturedAt: true,
      rowCount: true,
      candidateMatchCount: true,
      unmatchedCount: true,
    },
  });
  return rows.map((row) => access.assertOwned(row));
}

export async function loadOwnedBankSourceFile(
  db: Db,
  access: BankReconciliationAccess,
  importId: string,
): Promise<BankSourceFile> {
  requireOwnerReview(access);
  const record = await db.bankReconciliationImport.findFirst({
    where: { id: importId, businessId: access.businessId },
    select: { id: true, businessId: true, sourceLabel: true, sourceBytes: true },
  });
  if (!record) {
    throw new BankReconciliationError(BANK_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(record);
  return {
    filename: record.sourceLabel,
    bytes: Buffer.from(record.sourceBytes),
  };
}

async function loadMatchSources(
  db: Db,
  access: BankReconciliationAccess,
) {
  const timeZone = resolveBusinessTimeZone(access.workspace.business);
  const [payments, expenses] = await Promise.all([
    db.payment.findMany({
      where: { businessId: access.businessId },
      select: {
        id: true,
        amount: true,
        receivedAt: true,
        note: true,
        method: true,
        purpose: true,
      },
    }),
    db.expense.findMany({
      where: { businessId: access.businessId, ...ACTIVE_EXPENSE_WHERE },
      select: {
        id: true,
        amount: true,
        occurredOn: true,
        description: true,
        vendor: true,
        voidedAt: true,
      },
    }),
  ]);
  return { payments, expenses, timeZone };
}

async function persistImport(
  db: Db,
  access: BankReconciliationAccess,
  input: { sourceLabel: string; bytes: Buffer },
): Promise<BankReconciliationWorkspace> {
  requireOwnerReview(access);
  const businessId = access.businessId;
  if (input.bytes.byteLength > MAX_BANK_CSV_BYTES) {
    throw new BankReconciliationError(FILE_TOO_LARGE_MESSAGE);
  }
  const contentSha256 = hashCsvBytes(input.bytes);
  const existing = await db.bankReconciliationImport.findFirst({
    where: { businessId, contentSha256 },
    select: { id: true, businessId: true },
  });
  if (existing) {
    access.assertOwned(existing);
    return loadOwnedBankReconciliation(db, access, existing.id);
  }

  const parsed = parseBankCsv(decodeCsvBytes(input.bytes));
  const sources = await loadMatchSources(db, access);
  const suggestions = suggestBankMatches(parsed, sources);
  const totals = summarizeBankWorkspace(
    parsed,
    [...suggestions.values()].flatMap((matches) =>
      matches.map((match) => ({ status: "SUGGESTED", candidateKind: match.candidateKind })),
    ),
  );

  try {
    const created = await db.$transaction(async (tx) => {
      const importRow = await tx.bankReconciliationImport.create({
        data: {
          businessId,
          sourceKind: "CSV_UPLOAD",
          sourceLabel: input.sourceLabel,
          contentSha256,
          sourceBytes: input.bytes,
          capturedAt: new Date(),
          status: "REVIEW",
          ...workspaceCountsWrite(totals),
          createdByMembershipId: membershipId(access),
          rows: {
            create: parsed.map((row) => rowWriteData(businessId, row)),
          },
        },
        include: { rows: { select: { id: true, rowNumber: true } } },
      });
      const matchRows = importRow.rows.flatMap((stored) =>
        (suggestions.get(stored.rowNumber) ?? []).map((match) => ({
          businessId,
          importId: importRow.id,
          rowId: stored.id,
          candidateKind: match.candidateKind,
          candidateId: match.candidateId,
          score: match.score,
          matchReason: match.matchReason,
          status: "SUGGESTED",
        })),
      );
      if (matchRows.length > 0) {
        await tx.bankReconciliationMatch.createMany({ data: matchRows });
      }
      return importRow;
    });
    return loadOwnedBankReconciliation(db, access, created.id);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await db.bankReconciliationImport.findFirst({
        where: { businessId, contentSha256 },
        select: { id: true, businessId: true },
      });
      if (raced) {
        access.assertOwned(raced);
        return loadOwnedBankReconciliation(db, access, raced.id);
      }
    }
    throw error;
  }
}

export async function importBankCsv(
  db: Db,
  access: BankReconciliationAccess,
  input: { filename: string; bytes: Uint8Array | Buffer },
): Promise<BankReconciliationWorkspace> {
  return persistImport(db, access, {
    sourceLabel: sanitizeSourceFilename(input.filename),
    bytes: Buffer.from(input.bytes),
  });
}

async function refreshWorkspaceCounts(
  db: Db,
  access: BankReconciliationAccess,
  importId: string,
) {
  const workspace = await loadOwnedBankReconciliation(db, access, importId);
  await db.bankReconciliationImport.update({
    where: { id: workspace.id },
    data: workspaceCountsWrite(workspace),
  });
  return workspace;
}

function findOwnedRow(access: BankReconciliationAccess, workspace: BankReconciliationWorkspace, rowId: string) {
  const row = workspace.rows.find((candidate) => candidate.id === rowId) ?? null;
  if (!row || row.businessId !== access.businessId || row.importId !== workspace.id) {
    throw new BankReconciliationError(BANK_IMPORT_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(row);
  return row;
}

export async function acceptBankReconciliationMatch(
  db: Db,
  access: BankReconciliationAccess,
  input: { importId: string; matchId: string },
): Promise<BankReconciliationWorkspace> {
  requireOwnerReview(access);
  const workspace = await loadOwnedBankReconciliation(db, access, input.importId);
  const match = workspace.rows.flatMap((row) => row.matches).find((row) => row.id === input.matchId);
  if (!match || match.businessId !== access.businessId || match.importId !== workspace.id) {
    throw new BankReconciliationError(BANK_MATCH_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(match);
  const row = findOwnedRow(access, workspace, match.rowId);
  if (row.reviewStatus === "DUPLICATE" || row.reviewStatus === "INVALID") {
    throw new BankReconciliationError(BANK_ROW_NOT_REVIEWABLE_MESSAGE);
  }
  if (match.status === "ACCEPTED" && row.reviewStatus === "ACCEPTED") {
    return workspace;
  }
  if (match.status === "REJECTED") {
    throw new BankReconciliationError(BANK_MATCH_ALREADY_DECIDED_MESSAGE);
  }

  const alreadyAccepted = await db.bankReconciliationMatch.findFirst({
    where: {
      businessId: access.businessId,
      importId: workspace.id,
      candidateKind: match.candidateKind,
      candidateId: match.candidateId,
      status: "ACCEPTED",
      id: { not: match.id },
    },
    select: { id: true },
  });
  if (alreadyAccepted) {
    throw new BankReconciliationError(BANK_CANDIDATE_ALREADY_ACCEPTED_MESSAGE);
  }

  await db.$transaction(async (tx) => {
    await tx.bankReconciliationMatch.updateMany({
      where: {
        businessId: access.businessId,
        importId: workspace.id,
        rowId: row.id,
        id: { not: match.id },
        status: "SUGGESTED",
      },
      data: { status: "REJECTED", decidedAt: new Date(), decidedByMembershipId: membershipId(access) },
    });
    await tx.bankReconciliationMatch.update({
      where: { id: match.id },
      data: {
        status: "ACCEPTED",
        decidedAt: new Date(),
        decidedByMembershipId: membershipId(access),
      },
    });
    await tx.bankReconciliationRow.update({
      where: { id: row.id },
      data: { reviewStatus: "ACCEPTED" },
    });
  });
  return refreshWorkspaceCounts(db, access, workspace.id);
}

export async function rejectBankReconciliationMatch(
  db: Db,
  access: BankReconciliationAccess,
  input: { importId: string; matchId: string },
): Promise<BankReconciliationWorkspace> {
  requireOwnerReview(access);
  const workspace = await loadOwnedBankReconciliation(db, access, input.importId);
  const match = workspace.rows.flatMap((row) => row.matches).find((row) => row.id === input.matchId);
  if (!match || match.businessId !== access.businessId || match.importId !== workspace.id) {
    throw new BankReconciliationError(BANK_MATCH_NOT_AVAILABLE_MESSAGE);
  }
  access.assertOwned(match);
  if (match.status === "REJECTED") {
    return workspace;
  }
  if (match.status === "ACCEPTED") {
    throw new BankReconciliationError(BANK_MATCH_ALREADY_DECIDED_MESSAGE);
  }
  const row = findOwnedRow(access, workspace, match.rowId);
  await db.$transaction(async (tx) => {
    await tx.bankReconciliationMatch.update({
      where: { id: match.id },
      data: {
        status: "REJECTED",
        decidedAt: new Date(),
        decidedByMembershipId: membershipId(access),
      },
    });
    const remaining = await tx.bankReconciliationMatch.count({
      where: {
        businessId: access.businessId,
        rowId: row.id,
        status: "SUGGESTED",
        id: { not: match.id },
      },
    });
    if (row.reviewStatus === "CANDIDATE" && remaining === 0) {
      await tx.bankReconciliationRow.update({
        where: { id: row.id },
        data: { reviewStatus: "UNMATCHED" },
      });
    }
  });
  return refreshWorkspaceCounts(db, access, workspace.id);
}

export async function ignoreBankReconciliationRow(
  db: Db,
  access: BankReconciliationAccess,
  input: { importId: string; rowId: string },
): Promise<BankReconciliationWorkspace> {
  requireOwnerReview(access);
  const workspace = await loadOwnedBankReconciliation(db, access, input.importId);
  const row = findOwnedRow(access, workspace, input.rowId);
  if (row.reviewStatus === "ACCEPTED" || row.reviewStatus === "INVALID") {
    throw new BankReconciliationError(BANK_ROW_NOT_REVIEWABLE_MESSAGE);
  }
  if (row.reviewStatus === "IGNORED") {
    return workspace;
  }
  await db.bankReconciliationRow.update({
    where: { id: row.id },
    data: { reviewStatus: "IGNORED" },
  });
  return refreshWorkspaceCounts(db, access, workspace.id);
}
