"use server";

/**
 * Expense server actions. Tenant scope always comes from
 * requireBusinessAccess() (session workspace), never from a client
 * businessId. OWNER/ADMIN only (MANAGE_EXPENSES).
 */
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import {
  attachExpenseReceipt,
  createExpense,
  expenseErrorMessage,
  reviewExpense,
  setReimbursementStatus,
} from "@/lib/expense-ops";
import { prisma } from "@/lib/prisma";
import {
  isStorageConfigured,
  isSupportedImageMimeType,
  MAX_JOB_PHOTO_UPLOAD_BYTES,
  uploadExpenseReceipt,
} from "@/lib/storage";

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

async function maybeUploadReceipt(accessBusinessId: string, expenseId: string, file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.size === 0) {
    return null;
  }
  if (!isSupportedImageMimeType(file.type)) {
    throw new Error("Unsupported receipt type. Upload a JPEG, PNG, WebP, GIF, or HEIC image.");
  }
  if (file.size > MAX_JOB_PHOTO_UPLOAD_BYTES) {
    const maxMb = (MAX_JOB_PHOTO_UPLOAD_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`That receipt is too large. The limit is ${maxMb} MB.`);
  }
  if (!isStorageConfigured()) {
    throw new Error(
      "Receipt storage isn't set up yet. Ask an admin to connect Vercel Blob (BLOB_READ_WRITE_TOKEN).",
    );
  }
  const uploaded = await uploadExpenseReceipt({
    businessId: accessBusinessId,
    expenseId,
    file,
  });
  return uploaded.url;
}

export async function createExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireBusinessAccess();
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
      paymentMethod: readString(formData, "paymentMethod") || undefined,
      taxCategory: readString(formData, "taxCategory") || undefined,
      recurring: readChecked(formData, "recurring"),
      recurringNote: readString(formData, "recurringNote") || undefined,
      mileageMiles: readString(formData, "mileageMiles") || undefined,
      notes: readString(formData, "notes") || undefined,
    });

    const file = formData.get("receipt");
    if (file instanceof File && file.size > 0) {
      const receiptUrl = await maybeUploadReceipt(access.businessId, expense.id, file);
      if (receiptUrl) {
        await attachExpenseReceipt(prisma, access, { expenseId: expense.id, receiptUrl });
      }
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
    const access = await requireBusinessAccess();
    await createExpense(prisma, access, {
      occurredOn: readString(formData, "occurredOn"),
      description: readString(formData, "description") || "Mileage",
      amount: readString(formData, "amount"),
      category: "MILEAGE",
      purchaserMembershipId: readString(formData, "purchaserMembershipId") || undefined,
      jobId: readString(formData, "jobId") || undefined,
      customerId: readString(formData, "customerId") || undefined,
      reimbursable: readChecked(formData, "reimbursable"),
      mileageMiles: readString(formData, "mileageMiles"),
      notes: readString(formData, "notes") || undefined,
    });
    revalidateExpenses();
    return { message: "Mileage expense recorded." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not record that mileage expense.") };
  }
}

export async function reviewExpenseAction(
  _prev: ExpenseActionState,
  formData: FormData,
): Promise<ExpenseActionState> {
  try {
    const access = await requireBusinessAccess();
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
    const access = await requireBusinessAccess();
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
    const access = await requireBusinessAccess();
    const expenseId = readString(formData, "expenseId");
    if (!expenseId) return { error: "That expense could not be found." };
    const receiptUrl = await maybeUploadReceipt(access.businessId, expenseId, formData.get("receipt"));
    if (!receiptUrl) {
      return { error: "Choose a receipt image to upload." };
    }
    await attachExpenseReceipt(prisma, access, { expenseId, receiptUrl });
    revalidateExpenses();
    return { message: "Receipt attached." };
  } catch (error) {
    return { error: expenseErrorMessage(error, "Could not attach that receipt.") };
  }
}
