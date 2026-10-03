/**
 * OWNER read-only Plaid connection and Transactions Sync.
 *
 * Sync writes review rows into the existing BankReconciliation workspace.
 * This module never creates a Payment, never updates Invoice / Expense,
 * never writes InvoiceCredit, never moves money, and never returns a
 * verified cash balance.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  BANK_CONNECT_ALREADY_CONNECTED_MESSAGE,
  BANK_CONNECT_DISCONNECTED_MESSAGE,
  BANK_CONNECT_NEEDS_REAUTH_MESSAGE,
  BANK_CONNECT_NOT_AVAILABLE_MESSAGE,
  BANK_CONNECT_NOT_CONFIGURED_MESSAGE,
  BANK_CONNECT_REVIEW_ONLY_MESSAGE,
  OWNER_ONLY_BANK_CONNECT_MESSAGE,
} from "@/lib/bank-connect-copy";
import {
  BankReconciliationError,
  MAX_BANK_AMOUNT_CENTS,
  MIN_BANK_AMOUNT_CENTS,
  bankRowFingerprint,
  directionFromCents,
  markAlreadySeenBankRows,
  suggestBankMatches,
  summarizeBankWorkspace,
  workspaceCountsWrite,
  type ParsedBankRow,
} from "@/lib/bank-reconciliation";
import { DEFAULT_BUSINESS_TIMEZONE, resolveBusinessTimeZone } from "@/lib/business-timezone";
import { ACTIVE_EXPENSE_WHERE } from "@/lib/expenses";
import {
  decryptPlaidAccessToken,
  encryptPlaidAccessToken,
  PlaidTokenCryptoError,
} from "@/lib/plaid-token-crypto";
import {
  isPlaidLoginRequired,
  plaidAdapterKind,
  PlaidProviderError,
  resolvePlaidProvider,
  resolvePlaidWebhookUrl,
  type PlaidProvider,
  type PlaidSyncedTransaction,
} from "@/lib/plaid-provider";

type Db = PrismaClient;
export type BankConnectAccess = BusinessAccess;

export class BankConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankConnectError";
  }
}

export type BankPlaidStatusView = {
  adapter: "fake" | "plaid" | "unconfigured";
  status: string;
  institutionName: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  importId: string | null;
  reviewOnlyMessage: string;
};

function requireOwnerConnect(access: BankConnectAccess) {
  requireBusinessCapability(access, CAPABILITIES.REVIEW_BANK_RECONCILIATION);
}

function membershipId(access: BankConnectAccess): string {
  const id = access.workspace.membership?.id?.trim();
  if (!id) throw new BankConnectError(OWNER_ONLY_BANK_CONNECT_MESSAGE);
  return id;
}

function providerOrThrow(env: NodeJS.ProcessEnv = process.env): PlaidProvider {
  try {
    return resolvePlaidProvider(env);
  } catch (error) {
    if (error instanceof PlaidProviderError && error.code === "NOT_CONFIGURED") {
      throw new BankConnectError(BANK_CONNECT_NOT_CONFIGURED_MESSAGE);
    }
    throw error;
  }
}

function plaidContentSha(itemId: string) {
  return createHash("sha256").update(`plaid-item:${itemId}`).digest("hex");
}

function plaidAmountToSignedCents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(Math.abs(amount) * 100);
  const signed = amount > 0 ? -cents : amount < 0 ? cents : 0;
  if (!Number.isSafeInteger(signed)) return null;
  if (signed > MAX_BANK_AMOUNT_CENTS || signed < MIN_BANK_AMOUNT_CENTS) return null;
  return signed;
}

function parsedFromPlaid(
  rowNumber: number,
  txn: PlaidSyncedTransaction,
): ParsedBankRow {
  const amountCents = plaidAmountToSignedCents(txn.amount) ?? 0;
  const postedOn = /^\d{4}-\d{2}-\d{2}$/.test(txn.date) ? txn.date : null;
  const description = txn.name.trim().slice(0, 240);
  let invalidReason: string | null = null;
  if (!postedOn) invalidReason = "Enter a valid posted date.";
  else if (plaidAmountToSignedCents(txn.amount) == null) {
    invalidReason = "Enter an amount with at most two decimal places.";
  }
  return {
    rowNumber,
    postedOn,
    description,
    amountCents,
    direction: directionFromCents(amountCents),
    rowFingerprint: bankRowFingerprint({ postedOn, amountCents, description }),
    rawLine: JSON.stringify({
      transaction_id: txn.transactionId,
      account_id: txn.accountId,
      date: txn.date,
      amount: txn.amount,
      name: txn.name,
    }),
    reviewStatus: invalidReason ? "INVALID" : "UNMATCHED",
    invalidReason,
    reversalOfRowNumber: null,
    duplicateOfRowNumber: null,
    externalTransactionId: txn.transactionId,
  };
}

async function loadMatchSources(db: Db | Prisma.TransactionClient, businessId: string) {
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { timezone: true },
  });
  const timeZone = business
    ? resolveBusinessTimeZone(business)
    : DEFAULT_BUSINESS_TIMEZONE;
  const [payments, expenses] = await Promise.all([
    db.payment.findMany({
      where: { businessId },
      select: { id: true, amount: true, receivedAt: true, note: true, method: true, purpose: true },
    }),
    db.expense.findMany({
      where: { businessId, ...ACTIVE_EXPENSE_WHERE },
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

export async function loadOwnedBankPlaidStatus(
  db: Db,
  access: BankConnectAccess,
): Promise<BankPlaidStatusView> {
  requireOwnerConnect(access);
  const item = await db.bankPlaidItem.findFirst({
    where: { businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      itemId: true,
      status: true,
      institutionName: true,
      connectedAt: true,
      lastSyncedAt: true,
    },
  });
  if (item) access.assertOwned(item);
  const feed = item
    ? await db.bankReconciliationImport.findFirst({
        where: { businessId: access.businessId, contentSha256: plaidContentSha(item.itemId) },
        select: { id: true, businessId: true },
      })
    : null;
  if (feed) access.assertOwned(feed);
  return {
    adapter: plaidAdapterKind(),
    status: item?.status ?? "DISCONNECTED",
    institutionName: item?.institutionName ?? null,
    connectedAt: item && item.status !== "DISCONNECTED" ? item.connectedAt : null,
    lastSyncedAt: item?.lastSyncedAt ?? null,
    importId: feed?.id ?? null,
    reviewOnlyMessage: BANK_CONNECT_REVIEW_ONLY_MESSAGE,
  };
}

export async function createOwnedBankLinkToken(
  db: Db,
  access: BankConnectAccess,
  input: { updateMode?: boolean } = {},
): Promise<{ linkToken: string; updateMode: boolean }> {
  requireOwnerConnect(access);
  const provider = providerOrThrow();
  let accessToken: string | undefined;
  if (input.updateMode) {
    const item = await db.bankPlaidItem.findFirst({
      where: { businessId: access.businessId },
    });
    if (!item || item.status === "DISCONNECTED" || !item.accessTokenCipher) {
      throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
    }
    access.assertOwned(item);
    try {
      accessToken = decryptPlaidAccessToken(item.accessTokenCipher);
    } catch (error) {
      if (error instanceof PlaidTokenCryptoError) {
        throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
      }
      throw error;
    }
  } else {
    const existing = await db.bankPlaidItem.findFirst({
      where: { businessId: access.businessId, status: { not: "DISCONNECTED" } },
      select: { id: true, businessId: true },
    });
    if (existing) {
      access.assertOwned(existing);
      throw new BankConnectError(BANK_CONNECT_ALREADY_CONNECTED_MESSAGE);
    }
  }
  return provider.createLinkToken({
    clientUserId: `${access.businessId}:${membershipId(access)}`,
    accessToken,
    webhookUrl: resolvePlaidWebhookUrl(),
  });
}

async function ensurePlaidWorkspace(
  db: Db,
  access: BankConnectAccess,
  input: { itemId: string; institutionName: string },
) {
  const contentSha256 = plaidContentSha(input.itemId);
  const existing = await db.bankReconciliationImport.findFirst({
    where: { businessId: access.businessId, contentSha256 },
  });
  if (existing) {
    access.assertOwned(existing);
    return existing;
  }
  return db.bankReconciliationImport.create({
    data: {
      businessId: access.businessId,
      sourceKind: "PLAID_SYNC",
      sourceLabel: `${input.institutionName} feed`,
      contentSha256,
      sourceBytes: Uint8Array.from(
        Buffer.from(JSON.stringify({ itemId: input.itemId, kind: "PLAID_SYNC" })),
      ),
      capturedAt: new Date(),
      status: "REVIEW",
      rowCount: 0,
      depositCount: 0,
      withdrawalCount: 0,
      unmatchedCount: 0,
      candidateMatchCount: 0,
      duplicateRowCount: 0,
      reversedCount: 0,
      invalidCount: 0,
      createdByMembershipId: membershipId(access),
    },
  });
}

export async function exchangeOwnedBankPublicToken(
  db: Db,
  access: BankConnectAccess,
  input: { publicToken: string; updateMode?: boolean },
): Promise<BankPlaidStatusView> {
  requireOwnerConnect(access);
  const publicToken = input.publicToken.trim();
  if (!publicToken) throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
  const provider = providerOrThrow();

  if (input.updateMode) {
    const item = await db.bankPlaidItem.findFirst({
      where: { businessId: access.businessId },
    });
    if (!item || !item.accessTokenCipher) {
      throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
    }
    access.assertOwned(item);
    try {
      const token = decryptPlaidAccessToken(item.accessTokenCipher);
      await provider.restoreLogin(token);
    } catch {
      /* Update mode may not mint a new public token; restore locally after Link. */
    }
    try {
      await provider.exchangePublicToken(publicToken);
    } catch {
      /* Link update mode can complete without a reusable public token. */
    }
    await db.bankPlaidItem.update({
      where: { id: item.id },
      data: { status: "ACTIVE", disconnectedAt: null },
    });
    await syncBankPlaidItem(db, {
      businessId: access.businessId,
      actorMembershipId: membershipId(access),
      access,
    });
    return loadOwnedBankPlaidStatus(db, access);
  }

  const existing = await db.bankPlaidItem.findFirst({
    where: { businessId: access.businessId, status: { not: "DISCONNECTED" } },
  });
  if (existing) {
    access.assertOwned(existing);
    throw new BankConnectError(BANK_CONNECT_ALREADY_CONNECTED_MESSAGE);
  }

  const exchanged = await provider.exchangePublicToken(publicToken);
  const [institution, accounts] = await Promise.all([
    provider.getItem(exchanged.accessToken),
    provider.getAccounts(exchanged.accessToken),
  ]);
  const cipher = encryptPlaidAccessToken(exchanged.accessToken);
  const disconnected = await db.bankPlaidItem.findFirst({
    where: { businessId: access.businessId, status: "DISCONNECTED" },
  });
  const connectedAt = new Date();
  const item = disconnected
    ? await db.bankPlaidItem.update({
        where: { id: disconnected.id },
        data: {
          itemId: exchanged.itemId,
          institutionId: institution.institutionId,
          institutionName: institution.institutionName,
          status: "ACTIVE",
          accessTokenCipher: cipher,
          syncCursor: "",
          lastSyncedAt: null,
          connectedAt,
          disconnectedAt: null,
          createdByMembershipId: membershipId(access),
        },
      })
    : await db.bankPlaidItem.create({
        data: {
          businessId: access.businessId,
          itemId: exchanged.itemId,
          institutionId: institution.institutionId,
          institutionName: institution.institutionName,
          status: "ACTIVE",
          accessTokenCipher: cipher,
          syncCursor: "",
          connectedAt,
          createdByMembershipId: membershipId(access),
        },
      });
  access.assertOwned(item);
  await db.bankPlaidAccount.deleteMany({
    where: { businessId: access.businessId, itemRowId: item.id },
  });
  if (accounts.length > 0) {
    await db.bankPlaidAccount.createMany({
      data: accounts.map((account) => ({
        businessId: access.businessId,
        itemRowId: item.id,
        accountId: account.accountId,
        name: account.name,
        officialName: account.officialName,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype,
      })),
    });
  }
  await ensurePlaidWorkspace(db, access, {
    itemId: item.itemId,
    institutionName: item.institutionName,
  });
  await syncBankPlaidItem(db, {
    businessId: access.businessId,
    actorMembershipId: membershipId(access),
    access,
  });
  return loadOwnedBankPlaidStatus(db, access);
}

export async function disconnectOwnedBankPlaidItem(
  db: Db,
  access: BankConnectAccess,
): Promise<BankPlaidStatusView> {
  requireOwnerConnect(access);
  const item = await db.bankPlaidItem.findFirst({
    where: { businessId: access.businessId },
  });
  if (!item) throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
  access.assertOwned(item);
  if (item.status === "DISCONNECTED") {
    return loadOwnedBankPlaidStatus(db, access);
  }
  if (item.accessTokenCipher) {
    try {
      const token = decryptPlaidAccessToken(item.accessTokenCipher);
      await providerOrThrow().removeItem(token);
    } catch {
      /* Provider removal is best-effort; local disconnect still proceeds. */
    }
  }
  await db.bankPlaidItem.update({
    where: { id: item.id },
    data: {
      status: "DISCONNECTED",
      accessTokenCipher: "",
      syncCursor: "",
      disconnectedAt: new Date(),
    },
  });
  return loadOwnedBankPlaidStatus(db, access);
}

export async function syncOwnedBankPlaidItem(
  db: Db,
  access: BankConnectAccess,
): Promise<BankPlaidStatusView> {
  requireOwnerConnect(access);
  await syncBankPlaidItem(db, {
    businessId: access.businessId,
    actorMembershipId: membershipId(access),
    access,
  });
  return loadOwnedBankPlaidStatus(db, access);
}

async function lockPlaidItem(
  tx: Prisma.TransactionClient,
  businessId: string,
) {
  const rows = await tx.$queryRaw<Array<{
    id: string;
    businessId: string;
    itemId: string;
    status: string;
    accessTokenCipher: string;
    syncCursor: string;
    institutionName: string;
    createdByMembershipId: string;
  }>>`
    SELECT id, "businessId", "itemId", status, "accessTokenCipher", "syncCursor",
           "institutionName", "createdByMembershipId"
    FROM "BankPlaidItem"
    WHERE "businessId" = ${businessId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function syncBankPlaidItem(
  db: Db,
  input: {
    businessId: string;
    actorMembershipId: string;
    access?: BankConnectAccess;
  },
): Promise<{ importId: string | null; added: number; removed: number }> {
  const provider = providerOrThrow();
  let addedCount = 0;
  let removedCount = 0;
  let importId: string | null = null;

  try {
    await db.$transaction(async (tx) => {
      const locked = await lockPlaidItem(tx, input.businessId);
      if (!locked) throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
      if (input.access) input.access.assertOwned(locked);
      if (locked.status === "DISCONNECTED" || !locked.accessTokenCipher) {
        throw new BankConnectError(BANK_CONNECT_DISCONNECTED_MESSAGE);
      }
      let accessToken: string;
      try {
        accessToken = decryptPlaidAccessToken(locked.accessTokenCipher);
      } catch {
        throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
      }

      let cursor = locked.syncCursor;
      const added: PlaidSyncedTransaction[] = [];
      const modified: PlaidSyncedTransaction[] = [];
      const removed: string[] = [];
      for (let page = 0; page < 20; page += 1) {
        const batch = await provider.transactionsSync({ accessToken, cursor });
        added.push(...batch.added);
        modified.push(...batch.modified);
        removed.push(...batch.removed);
        cursor = batch.nextCursor;
        if (!batch.hasMore) break;
      }

      const workspace = await tx.bankReconciliationImport.findFirst({
        where: { businessId: input.businessId, contentSha256: plaidContentSha(locked.itemId) },
      });
      if (!workspace) {
        throw new BankConnectError(BANK_CONNECT_NOT_AVAILABLE_MESSAGE);
      }
      importId = workspace.id;
      if (input.access) input.access.assertOwned(workspace);

      const lastRow = await tx.bankReconciliationRow.findFirst({
        where: { importId: workspace.id, businessId: input.businessId },
        orderBy: { rowNumber: "desc" },
        select: { rowNumber: true },
      });
      let nextRowNumber = (lastRow?.rowNumber ?? 1) + 1;

      const applyRows: ParsedBankRow[] = [];
      for (const txn of [...added, ...modified]) {
        if (txn.pending) continue;
        const existing = await tx.bankPlaidTransaction.findFirst({
          where: { businessId: input.businessId, transactionId: txn.transactionId },
        });
        const parsed = parsedFromPlaid(existing?.rowId ? 0 : nextRowNumber, txn);
        if (!existing) {
          if (!parsed.reviewStatus || parsed.reviewStatus === "UNMATCHED" || parsed.reviewStatus === "INVALID") {
            parsed.rowNumber = nextRowNumber;
            nextRowNumber += 1;
            applyRows.push(parsed);
          }
          const createdRow = parsed.reviewStatus === "INVALID" || parsed.postedOn
            ? await tx.bankReconciliationRow.create({
                data: {
                  businessId: input.businessId,
                  importId: workspace.id,
                  rowNumber: parsed.rowNumber,
                  postedOn: parsed.postedOn,
                  description: parsed.description,
                  amountCents: parsed.amountCents,
                  direction: parsed.direction,
                  rowFingerprint: parsed.rowFingerprint,
                  rawLine: parsed.rawLine,
                  reviewStatus: parsed.reviewStatus,
                  invalidReason: parsed.invalidReason,
                  externalTransactionId: txn.transactionId,
                },
              })
            : null;
          await tx.bankPlaidTransaction.create({
            data: {
              businessId: input.businessId,
              itemRowId: locked.id,
              transactionId: txn.transactionId,
              accountId: txn.accountId,
              postedOn: parsed.postedOn ?? txn.date,
              amountCents: parsed.amountCents,
              description: parsed.description,
              pending: false,
              removed: false,
              importId: workspace.id,
              rowId: createdRow?.id ?? null,
            },
          });
          addedCount += 1;
        } else if (!existing.removed && existing.rowId) {
          const row = await tx.bankReconciliationRow.findFirst({
            where: { id: existing.rowId, businessId: input.businessId },
          });
          if (row && (row.reviewStatus === "UNMATCHED" || row.reviewStatus === "CANDIDATE")) {
            await tx.bankReconciliationRow.update({
              where: { id: row.id },
              data: {
                postedOn: parsed.postedOn,
                description: parsed.description,
                amountCents: parsed.amountCents,
                direction: parsed.direction,
                rowFingerprint: parsed.rowFingerprint,
                rawLine: parsed.rawLine,
              },
            });
          }
          await tx.bankPlaidTransaction.update({
            where: { id: existing.id },
            data: {
              postedOn: parsed.postedOn ?? txn.date,
              amountCents: parsed.amountCents,
              description: parsed.description,
              removed: false,
            },
          });
        }
      }

      for (const transactionId of removed) {
        const existing = await tx.bankPlaidTransaction.findFirst({
          where: { businessId: input.businessId, transactionId },
        });
        if (!existing) continue;
        await tx.bankPlaidTransaction.update({
          where: { id: existing.id },
          data: { removed: true },
        });
        if (existing.rowId) {
          const row = await tx.bankReconciliationRow.findFirst({
            where: { id: existing.rowId, businessId: input.businessId },
          });
          if (row && row.reviewStatus !== "ACCEPTED") {
            await tx.bankReconciliationRow.update({
              where: { id: row.id },
              data: {
                reviewStatus: "IGNORED",
                invalidReason: "Removed from the bank feed.",
              },
            });
          }
        }
        removedCount += 1;
      }

      if (applyRows.length > 0) {
        const fingerprints = applyRows.map((row) => row.rowFingerprint);
        const prior = await tx.bankReconciliationRow.findMany({
          where: {
            businessId: input.businessId,
            rowFingerprint: { in: fingerprints },
            importId: { not: workspace.id },
          },
          select: { rowFingerprint: true },
        });
        markAlreadySeenBankRows(
          applyRows,
          prior.map((row) => row.rowFingerprint),
        );
        const alreadySeen = new Set(
          applyRows.filter((row) => row.reviewStatus === "ALREADY_SEEN").map((row) => row.externalTransactionId),
        );
        if (alreadySeen.size > 0) {
          await tx.bankReconciliationRow.updateMany({
            where: {
              businessId: input.businessId,
              importId: workspace.id,
              externalTransactionId: { in: [...alreadySeen].filter((id): id is string => Boolean(id)) },
              reviewStatus: { notIn: ["ACCEPTED", "IGNORED"] },
            },
            data: { reviewStatus: "ALREADY_SEEN" },
          });
        }
        const sources = await loadMatchSources(tx, input.businessId);
        const suggestions = suggestBankMatches(
          applyRows.filter((row) => row.reviewStatus === "UNMATCHED"),
          sources,
        );
        const storedRows = await tx.bankReconciliationRow.findMany({
          where: { importId: workspace.id, businessId: input.businessId },
          select: { id: true, rowNumber: true },
        });
        const matchRows = storedRows.flatMap((stored) =>
          (suggestions.get(stored.rowNumber) ?? []).map((match) => ({
            businessId: input.businessId,
            importId: workspace.id,
            rowId: stored.id,
            candidateKind: match.candidateKind,
            candidateId: match.candidateId,
            score: match.score,
            matchReason: match.matchReason,
            status: "SUGGESTED",
          })),
        );
        if (matchRows.length > 0) {
          await tx.bankReconciliationMatch.createMany({ data: matchRows, skipDuplicates: true });
        }
        for (const [rowNumber] of suggestions) {
          const stored = storedRows.find((row) => row.rowNumber === rowNumber);
          if (!stored) continue;
          await tx.bankReconciliationRow.update({
            where: { id: stored.id },
            data: { reviewStatus: "CANDIDATE" },
          });
        }
      }

      const allRows = await tx.bankReconciliationRow.findMany({
        where: { importId: workspace.id, businessId: input.businessId },
        include: { matches: true },
      });
      const totals = summarizeBankWorkspace(
        allRows,
        allRows.flatMap((row) => row.matches),
      );
      await tx.bankReconciliationImport.update({
        where: { id: workspace.id },
        data: {
          ...workspaceCountsWrite(totals),
          sourceLabel: `${locked.institutionName} feed`,
          capturedAt: new Date(),
        },
      });
      await tx.bankPlaidItem.update({
        where: { id: locked.id },
        data: {
          syncCursor: cursor,
          lastSyncedAt: new Date(),
          status: "ACTIVE",
        },
      });
    }, { timeout: 30_000 });
  } catch (error) {
    if (isPlaidLoginRequired(error)) {
      await db.bankPlaidItem.updateMany({
        where: { businessId: input.businessId, status: { not: "DISCONNECTED" } },
        data: { status: "NEEDS_REAUTH" },
      });
      throw new BankConnectError(BANK_CONNECT_NEEDS_REAUTH_MESSAGE);
    }
    throw error;
  }

  return { importId, added: addedCount, removed: removedCount };
}

export async function handlePlaidWebhookPayload(
  db: Db,
  input: { rawBody: string },
): Promise<{ duplicate: boolean; processed: boolean }> {
  const eventKey = createHash("sha256").update(input.rawBody).digest("hex");
  let payload: {
    webhook_type?: string;
    webhook_code?: string;
    item_id?: string;
    error?: { error_code?: string };
  };
  try {
    payload = JSON.parse(input.rawBody) as typeof payload;
  } catch {
    throw new BankConnectError("Plaid webhook body is not JSON.");
  }
  const webhookType = String(payload.webhook_type ?? "");
  const webhookCode = String(payload.webhook_code ?? "");
  const itemId = String(payload.item_id ?? "");
  if (!webhookType || !webhookCode || !itemId) {
    throw new BankConnectError("Plaid webhook is missing item or type.");
  }

  try {
    await db.bankPlaidWebhookEvent.create({
      data: {
        itemId,
        eventKey,
        webhookType,
        webhookCode,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { duplicate: true, processed: false };
    }
    throw error;
  }

  const item = await db.bankPlaidItem.findFirst({
    where: { itemId },
  });
  if (!item) {
    await db.bankPlaidWebhookEvent.update({
      where: { eventKey },
      data: { processedAt: new Date() },
    });
    return { duplicate: false, processed: false };
  }

  await db.bankPlaidWebhookEvent.update({
    where: { eventKey },
    data: { businessId: item.businessId, itemRowId: item.id },
  });
  await db.bankPlaidItem.update({
    where: { id: item.id },
    data: { lastWebhookAt: new Date() },
  });

  const loginRequired =
    webhookCode === "ITEM_LOGIN_REQUIRED" ||
    webhookCode === "PENDING_EXPIRATION" ||
    webhookCode === "PENDING_DISCONNECT" ||
    payload.error?.error_code === "ITEM_LOGIN_REQUIRED";

  if (loginRequired && item.status !== "DISCONNECTED") {
    await db.bankPlaidItem.update({
      where: { id: item.id },
      data: { status: "NEEDS_REAUTH" },
    });
  }

  const shouldSync =
    webhookType === "TRANSACTIONS" ||
    webhookCode === "SYNC_UPDATES_AVAILABLE" ||
    webhookCode === "INITIAL_UPDATE" ||
    webhookCode === "HISTORICAL_UPDATE" ||
    webhookCode === "DEFAULT_UPDATE";

  if (shouldSync && item.status !== "DISCONNECTED") {
    await syncBankPlaidItem(db, {
      businessId: item.businessId,
      actorMembershipId: item.createdByMembershipId,
    });
  }

  await db.bankPlaidWebhookEvent.update({
    where: { eventKey },
    data: { processedAt: new Date() },
  });
  return { duplicate: false, processed: true };
}

export function bankConnectAdapterKind() {
  return plaidAdapterKind();
}
