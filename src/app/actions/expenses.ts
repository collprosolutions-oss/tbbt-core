"use server";

/**
 * Expense server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_EXPENSES). Receipts use private
 * managed storage — never a public file URL, and never used to infer
 * tax treatment.
 */
import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { isBusinessStorageConfigured } from "@/lib/business-storage/config";
import {
  inspectExpenseReceiptUpload,
  putExpenseReceiptFromBytes,
  removeExpenseReceiptAttachment,
} from "@/lib/business-storage/expense-receipts";
import {
  createExpense,
  expenseErrorMessage,
  reviewExpense,
  setReimbursementStatus,
  updateExpense,
  voidExpense,
} from "@/lib/expense-ops";
import { prisma } from "@/lib/prisma";

export type ExpenseActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readChecked(formData: FormData, key: string) {
  return readString(formData, key) === "1" || readString(formData, key) === "on";
}

function revalidateExpenses() {
  revalidatePath("/expenses");
}

async function maybeAttachReceipt(
  access: Awaited<ReturnType<typeof requireOperatingBusinessAccess>>,
  expenseId: string,
  file: FormDataEntryValue | null,
) {
  if (!(file instanceof File) || file.size === 0) {
    return null;
  }
  const body = Buffer.from(await file.arrayBuffer());
  const inspection = inspectExpenseReceiptUpload({
    type: file.type,
    name: file.name,
    size: file.size,
    body,
  });
  if (!inspection.ok) {
    throw new Error(inspection.error);
  }
  if (!isBusinessStorageConfigured()) {
    throw new Error(
      "Receipt storage isn't set up yet. Ask an admin to connect private business file storage.",
    );
  }
  await putExpenseReceiptFromBytes({ db: prisma }, access, {
    expenseId,
    originalFilename: inspection.fileName,
    mimeType: inspection.mimeType,
    body,
  });
  return true;
}

export async function createExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const expense = await createExpense(prisma, access, {
      occurredOn: readString(formData, "occurredOn"),
      description: readString(formData, "description"),
      amount: readString(formData, "amount"),
      category: readString(formData, "category"),
      vendor: readString(formData, "vendor"),
      purchaserMembershipId: readString(formData, "purchaserMembershipId") || undefined,
      jobId: readString(formData, "jobId") || undefined,
      customerId: readString(formData, "customerId") || undefined,
      reimbursable: readChecked(formData, "reimbursable"),
      customerBillable: readChecked(formData, "customerBillable"),
      paymentMethod: readString(formData, "paymentMethod") || undefined,
      taxCategory: readString(formData, "taxCategory") || undefined,
      recurring: readChecked(formData, "recurring"),
      recurringNote: readString(formData, "recurringNote") || undefined,
      mileageMiles: readString(formData, "mileageMiles") || undefined,
      notes: readString(formData, "notes") || undefined,
    });

    const file = formData.get("receipt");
    if (file instanceof File && file.size > 0) {
      await maybeAttachReceipt(access, expense.id, file);
    }

    revalidateExpenses();
    return { message: "Expense recorded." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not record that expense.") };
  }
}

export async function createMileageExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await createExpense(prisma, access, {
      occurredOn: readString(formData, "occurredOn"),
      description: readString(formData, "description") || "Mileage",
      amount: readString(formData, "amount"),
      category: "MILEAGE",
      purchaserMembershipId: readString(formData, "purchaserMembershipId") || undefined,
      jobId: readString(formData, "jobId") || undefined,
      customerId: readString(formData, "customerId") || undefined,
      reimbursable: readChecked(formData, "reimbursable"),
      customerBillable: readChecked(formData, "customerBillable"),
      mileageMiles: readString(formData, "mileageMiles"),
      notes: readString(formData, "notes") || undefined,
    });
    revalidateExpenses();
    return { message: "Mileage expense recorded." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not record that mileage expense.") };
  }
}

export async function updateExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const expenseId = readString(formData, "expenseId");
    if (!expenseId) return { error: "That expense could not be found." };
    await updateExpense(prisma, access, {
      expenseId,
      occurredOn: readString(formData, "occurredOn"),
      description: readString(formData, "description"),
      amount: readString(formData, "amount"),
      category: readString(formData, "category"),
      vendor: readString(formData, "vendor"),
      purchaserMembershipId: readString(formData, "purchaserMembershipId") || undefined,
      jobId: readString(formData, "jobId") || undefined,
      customerId: readString(formData, "customerId") || undefined,
      reimbursable: readChecked(formData, "reimbursable"),
      customerBillable: readChecked(formData, "customerBillable"),
      paymentMethod: readString(formData, "paymentMethod") || undefined,
      taxCategory: readString(formData, "taxCategory") || undefined,
      recurring: readChecked(formData, "recurring"),
      recurringNote: readString(formData, "recurringNote") || undefined,
      mileageMiles: readString(formData, "mileageMiles") || undefined,
      notes: readString(formData, "notes") || undefined,
    });
    revalidateExpenses();
    return { message: "Expense updated." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not update that expense.") };
  }
}

export async function voidExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const expenseId = readString(formData, "expenseId");
    if (!expenseId) return { error: "That expense could not be found." };
    await voidExpense(prisma, access, { expenseId });
    revalidateExpenses();
    return { message: "Expense voided." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not void that expense.") };
  }
}

export async function reviewExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await reviewExpense(prisma, access, {
      expenseId: readString(formData, "expenseId"),
      reviewStatus: readString(formData, "reviewStatus"),
    });
    revalidateExpenses();
    return { message: "Expense review updated." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not update that expense.") };
  }
}

export async function setReimbursementStatusAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await setReimbursementStatus(prisma, access, {
      expenseId: readString(formData, "expenseId"),
      reimbursementStatus: readString(formData, "reimbursementStatus"),
    });
    revalidateExpenses();
    return { message: "Reimbursement status updated." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not update reimbursement status.") };
  }
}

export async function attachExpenseReceiptAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const expenseId = readString(formData, "expenseId");
    if (!expenseId) return { error: "That expense could not be found." };
    const attached = await maybeAttachReceipt(access, expenseId, formData.get("receipt"));
    if (!attached) {
      return { error: "Choose a receipt file to upload." };
    }
    revalidateExpenses();
    return { message: "Receipt attached." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not attach that receipt.") };
  }
}

export async function removeExpenseReceiptAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const expenseId = readString(formData, "expenseId");
    if (!expenseId) return { error: "That expense could not be found." };
    await removeExpenseReceiptAttachment({ db: prisma }, access, expenseId);
    revalidateExpenses();
    return { message: "Receipt removed." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not remove that receipt.") };
  }
}
