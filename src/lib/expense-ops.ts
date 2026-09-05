/**
 * Expense mutations -- the real write path used by server actions and
 * the focused Expenses check. Every function takes an already-authorized
 * BusinessAccess and re-checks tenant + role before writing. Callers
 * must have already run requireBusinessAccess(); this module never
 * trusts a browser-supplied businessId.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  defaultReimbursementStatus,
  isExpenseCategory,
  isExpenseReviewStatus,
  isReimbursementStatus,
  normalizePaymentMethod,
  normalizeTaxCategory,
  parseExpenseAmount,
  parseExpenseDate,
  parseMileageMiles,
  type ExpenseCategory,
  type ExpenseReviewStatus,
  type ReimbursementStatus,
} from "@/lib/expenses";

type Db = PrismaClient | Prisma.TransactionClient;

export class ExpenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseError";
  }
}

export function expenseErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ExpenseError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && /receipt|storage|Unsupported|too large/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export type CreateExpenseInput = {
  occurredOn: string;
  description: string;
  amount: string;
  category: string;
  vendor?: string;
  purchaserMembershipId?: string;
  jobId?: string;
  customerId?: string;
  reimbursable?: boolean;
  paymentMethod?: string;
  taxCategory?: string;
  recurring?: boolean;
  recurringNote?: string;
  mileageMiles?: string;
  notes?: string;
  receiptUrl?: string;
  customerBillable?: boolean;
};

export type UpdateExpenseInput = CreateExpenseInput & {
  expenseId: string;
};

async function loadMembershipInBusiness(db: Db, businessId: string, membershipId: string) {
  const membership = await db.membership.findFirst({
    where: { id: membershipId, businessId },
    select: { id: true, businessId: true },
  });
  if (!membership) {
    throw new ExpenseError("That team member is not in this business.");
  }
  return membership;
}

async function loadJobInBusiness(db: Db, businessId: string, jobId: string) {
  const job = await db.job.findFirst({
    where: { id: jobId, businessId },
    select: { id: true, businessId: true, customerId: true },
  });
  if (!job) {
    throw new ExpenseError("That job is not in this business.");
  }
  return job;
}

async function loadCustomerInBusiness(db: Db, businessId: string, customerId: string) {
  const customer = await db.customer.findFirst({
    where: { id: customerId, businessId },
    select: { id: true, businessId: true },
  });
  if (!customer) {
    throw new ExpenseError("That customer is not in this business.");
  }
  return customer;
}

function requireCategory(raw: string): ExpenseCategory {
  if (!isExpenseCategory(raw)) {
    throw new ExpenseError("Choose a valid expense category.");
  }
  return raw;
}

function requireActiveExpense<T extends { voidedAt: Date | null }>(expense: T): T {
  if (expense.voidedAt) {
    throw new ExpenseError("This expense has been voided.");
  }
  return expense;
}

async function resolveExpenseFields(db: Db, access: BusinessAccess, input: CreateExpenseInput) {
  const occurredOn = parseExpenseDate(input.occurredOn);
  if (!occurredOn) {
    throw new ExpenseError("Enter a valid expense date.");
  }
  const description = input.description.trim();
  if (!description) {
    throw new ExpenseError("Enter a description.");
  }
  const amount = parseExpenseAmount(input.amount);
  if (!amount) {
    throw new ExpenseError("Enter a valid amount greater than zero.");
  }
  const category = requireCategory(input.category);

  let mileageMiles: Prisma.Decimal | null = null;
  if (category === "MILEAGE") {
    mileageMiles = parseMileageMiles(input.mileageMiles ?? "");
    if (!mileageMiles) {
      throw new ExpenseError("Enter the miles driven. TBBT does not invent a mileage rate.");
    }
  } else if (input.mileageMiles?.trim()) {
    mileageMiles = parseMileageMiles(input.mileageMiles);
    if (!mileageMiles) {
      throw new ExpenseError("Enter a valid mileage quantity, or leave it blank.");
    }
  }

  let purchaserMembershipId: string | null = null;
  if (input.purchaserMembershipId) {
    const membership = await loadMembershipInBusiness(db, access.businessId, input.purchaserMembershipId);
    purchaserMembershipId = membership.id;
  }

  let jobId: string | null = null;
  let customerId: string | null = null;
  if (input.jobId) {
    const job = await loadJobInBusiness(db, access.businessId, input.jobId);
    jobId = job.id;
    customerId = job.customerId;
  }
  if (input.customerId) {
    const customer = await loadCustomerInBusiness(db, access.businessId, input.customerId);
    customerId = customer.id;
  }

  return {
    occurredOn,
    description,
    amount,
    category,
    vendor: input.vendor?.trim() || null,
    purchaserMembershipId,
    jobId,
    customerId,
    reimbursable: Boolean(input.reimbursable),
    customerBillable: Boolean(input.customerBillable),
    paymentMethod: normalizePaymentMethod(input.paymentMethod ?? ""),
    taxCategory: normalizeTaxCategory(input.taxCategory ?? ""),
    recurring: Boolean(input.recurring),
    recurringNote: input.recurringNote?.trim() || null,
    mileageMiles,
    notes: input.notes?.trim() || null,
    receiptUrl: input.receiptUrl?.trim() || null,
  };
}

export async function createExpense(db: Db, access: BusinessAccess, input: CreateExpenseInput) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
  const fields = await resolveExpenseFields(db, access, input);

  return db.expense.create({
    data: {
      businessId: access.businessId,
      occurredOn: fields.occurredOn,
      description: fields.description,
      amount: fields.amount,
      category: fields.category,
      vendor: fields.vendor,
      purchaserMembershipId: fields.purchaserMembershipId,
      jobId: fields.jobId,
      customerId: fields.customerId,
      receiptUrl: fields.receiptUrl,
      reimbursable: fields.reimbursable,
      reimbursementStatus: defaultReimbursementStatus(fields.reimbursable),
      customerBillable: fields.customerBillable,
      paymentMethod: fields.paymentMethod,
      taxCategory: fields.taxCategory,
      recurring: fields.recurring,
      recurringNote: fields.recurringNote,
      mileageMiles: fields.mileageMiles,
      notes: fields.notes,
      reviewStatus: "RECORDED",
    },
  });
}

export async function updateExpense(db: Db, access: BusinessAccess, input: UpdateExpenseInput) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);

  const existing = requireActiveExpense(
    access.assertOwned(
      await db.expense.findFirst({
        where: { id: input.expenseId, ...access.scope },
      }),
    ),
  );

  const fields = await resolveExpenseFields(db, access, input);
  const reimbursementStatus = fields.reimbursable
    ? existing.reimbursementStatus === "NONE"
      ? "PENDING"
      : existing.reimbursementStatus
    : "NONE";

  return db.expense.update({
    where: { id: existing.id },
    data: {
      occurredOn: fields.occurredOn,
      description: fields.description,
      amount: fields.amount,
      category: fields.category,
      vendor: fields.vendor,
      purchaserMembershipId: fields.purchaserMembershipId,
      jobId: fields.jobId,
      customerId: fields.customerId,
      reimbursable: fields.reimbursable,
      reimbursementStatus,
      customerBillable: fields.customerBillable,
      paymentMethod: fields.paymentMethod,
      taxCategory: fields.taxCategory,
      recurring: fields.recurring,
      recurringNote: fields.recurringNote,
      mileageMiles: fields.mileageMiles,
      notes: fields.notes,
    },
  });
}

export async function voidExpense(
  db: Db,
  access: BusinessAccess,
  input: { expenseId: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);

  const existing = access.assertOwned(
    await db.expense.findFirst({
      where: { id: input.expenseId, ...access.scope },
    }),
  );
  if (existing.voidedAt) {
    throw new ExpenseError("This expense is already voided.");
  }

  return db.expense.update({
    where: { id: existing.id },
    data: { voidedAt: new Date() },
  });
}

export async function reviewExpense(
  db: Db,
  access: BusinessAccess,
  input: { expenseId: string; reviewStatus: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
  if (!isExpenseReviewStatus(input.reviewStatus) || input.reviewStatus === "RECORDED") {
    throw new ExpenseError("Choose Approve or Flag.");
  }
  const reviewStatus: ExpenseReviewStatus = input.reviewStatus;

  const expense = requireActiveExpense(
    access.assertOwned(
      await db.expense.findFirst({
        where: { id: input.expenseId, ...access.scope },
      }),
    ),
  );

  return db.expense.update({
    where: { id: expense.id },
    data: {
      reviewStatus,
      reviewedAt: new Date(),
      reviewedByMembershipId: access.workspace.membership.id,
    },
  });
}

export async function setReimbursementStatus(
  db: Db,
  access: BusinessAccess,
  input: { expenseId: string; reimbursementStatus: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
  if (!isReimbursementStatus(input.reimbursementStatus)) {
    throw new ExpenseError("Choose a valid reimbursement status.");
  }
  const reimbursementStatus: ReimbursementStatus = input.reimbursementStatus;

  const expense = requireActiveExpense(
    access.assertOwned(
      await db.expense.findFirst({
        where: { id: input.expenseId, ...access.scope },
      }),
    ),
  );

  if (!expense.reimbursable && reimbursementStatus !== "NONE") {
    throw new ExpenseError("Only reimbursable expenses can be marked reimbursed.");
  }

  return db.expense.update({
    where: { id: expense.id },
    data: { reimbursementStatus },
  });
}

export async function attachExpenseReceipt(
  db: Db,
  access: BusinessAccess,
  input: { expenseId: string; receiptUrl: string },
) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
  const receiptUrl = input.receiptUrl.trim();
  if (!receiptUrl) {
    throw new ExpenseError("A receipt URL is required.");
  }

  const expense = requireActiveExpense(
    access.assertOwned(
      await db.expense.findFirst({
        where: { id: input.expenseId, ...access.scope },
      }),
    ),
  );

  return db.expense.update({
    where: { id: expense.id },
    data: { receiptUrl },
  });
}

export async function loadOwnedExpense(db: Db, access: BusinessAccess, expenseId: string) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
  return access.assertOwned(
    await db.expense.findFirst({
      where: { id: expenseId, ...access.scope },
    }),
  );
}
