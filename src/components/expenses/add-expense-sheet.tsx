"use client";

import { useActionState } from "react";
import {
  attachExpenseReceiptAction,
  createExpenseAction,
  createMileageExpenseAction,
  updateExpenseAction,
  type ExpenseActionState,
} from "@/app/actions/expenses";
import type {
  ExpenseCustomerOption,
  ExpenseJobOption,
  ExpenseListItem,
  ExpenseWorkerOption,
} from "@/components/expenses/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  TAX_CATEGORIES,
  TAX_CATEGORY_LABELS,
} from "@/lib/expenses";
import { PAYMENT_METHODS } from "@/lib/invoice-payment";

const initialState: ExpenseActionState = {};

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30";

export type ExpenseSheetMode = "expense" | "mileage" | "recurring" | "receipt" | "edit";

export function AddExpenseSheet({
  open,
  onOpenChange,
  mode,
  workers,
  jobs,
  customers,
  defaultDate,
  storageConfigured,
  attachExpenseId,
  editingExpense,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ExpenseSheetMode;
  workers: ExpenseWorkerOption[];
  jobs: ExpenseJobOption[];
  customers: ExpenseCustomerOption[];
  defaultDate: string;
  storageConfigured: boolean;
  attachExpenseId?: string | null;
  editingExpense?: ExpenseListItem | null;
}) {
  if (mode === "mileage") {
    return (
      <MileageForm
        open={open}
        onOpenChange={onOpenChange}
        workers={workers}
        jobs={jobs}
        defaultDate={defaultDate}
      />
    );
  }
  if (mode === "receipt") {
    if (!attachExpenseId) {
      return (
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Upload Receipt</SheetTitle>
              <SheetDescription>
                Select an expense in the list first, then attach a receipt to it.
              </SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      );
    }
    return (
      <AttachReceiptForm
        open={open}
        onOpenChange={onOpenChange}
        expenseId={attachExpenseId}
        storageConfigured={storageConfigured}
      />
    );
  }
  if (mode === "edit" && !editingExpense) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Edit Expense</SheetTitle>
            <SheetDescription>Select an expense in the list first, then edit it.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <ExpenseForm
      open={open}
      onOpenChange={onOpenChange}
      mode={mode === "edit" ? "edit" : mode === "recurring" ? "recurring" : "expense"}
      workers={workers}
      jobs={jobs}
      customers={customers}
      defaultDate={defaultDate}
      storageConfigured={storageConfigured}
      editingExpense={mode === "edit" ? editingExpense : null}
    />
  );
}

function ExpenseForm({
  open,
  onOpenChange,
  mode,
  workers,
  jobs,
  customers,
  defaultDate,
  storageConfigured,
  editingExpense,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "expense" | "recurring" | "edit";
  workers: ExpenseWorkerOption[];
  jobs: ExpenseJobOption[];
  customers: ExpenseCustomerOption[];
  defaultDate: string;
  storageConfigured: boolean;
  editingExpense?: ExpenseListItem | null;
}) {
  const editing = mode === "edit" && editingExpense;
  const [state, formAction, pending] = useActionState(
    editing ? updateExpenseAction : createExpenseAction,
    initialState,
  );
  const recurring = mode === "recurring" || Boolean(editingExpense?.recurring);
  const dateValue = editingExpense?.occurredOnValue ?? defaultDate;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {editing ? "Edit Expense" : recurring && mode !== "edit" ? "Recurring Expense" : "Add Expense"}
          </SheetTitle>
          <SheetDescription>
            {editing
              ? "Update this expense. Linking a job stores the cost for later profitability — it does not add a line to an invoice."
              : recurring && mode !== "edit"
                ? "Identify this as a recurring expense. TBBT does not automatically bill or charge it."
                : "Record a business expense. Amounts are saved as entered."}
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="mt-4 space-y-3 px-4 pb-6" key={editingExpense?.id ?? "create"}>
          {editing ? <input type="hidden" name="expenseId" value={editingExpense.id} /> : null}
          {mode === "recurring" ? <input type="hidden" name="recurring" value="1" /> : null}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Date">
              <Input type="date" name="occurredOn" defaultValue={dateValue} required />
            </Field>
            <Field label="Amount">
              <Input
                name="amount"
                inputMode="decimal"
                placeholder="0.00"
                defaultValue={editingExpense?.amountValue ?? ""}
                required
              />
            </Field>
          </div>
          <Field label="Description">
            <Input
              name="description"
              placeholder="What was purchased"
              defaultValue={editingExpense?.description ?? ""}
              required
            />
          </Field>
          <Field label="Category">
            <select
              name="category"
              defaultValue={editingExpense?.category ?? "MATERIALS"}
              required
              className={selectClass}
            >
              {EXPENSE_CATEGORIES.filter((category) => category !== "MILEAGE").map((category) => (
                <option key={category} value={category}>
                  {EXPENSE_CATEGORY_LABELS[category]}
                </option>
              ))}
              <option value="MILEAGE">{EXPENSE_CATEGORY_LABELS.MILEAGE}</option>
            </select>
          </Field>
          <Field label="Merchant / vendor / payee">
            <Input name="vendor" placeholder="Home Depot, helper name, city permit…" defaultValue={editingExpense?.vendor ?? ""} />
          </Field>
          <Field label="Purchaser">
            <select
              name="purchaserMembershipId"
              defaultValue={editingExpense?.purchaserMembershipId ?? ""}
              className={selectClass}
            >
              <option value="">Unassigned</option>
              {workers.map((worker) => (
                <option key={worker.membershipId} value={worker.membershipId}>
                  {worker.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Job (optional)">
            <select name="jobId" defaultValue={editingExpense?.jobId ?? ""} className={selectClass}>
              <option value="">No job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Customer (optional)">
            <select name="customerId" defaultValue={editingExpense?.customerId ?? ""} className={selectClass}>
              <option value="">No customer</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payment method">
            <select name="paymentMethod" defaultValue={editingExpense?.paymentMethod ?? ""} className={selectClass}>
              <option value="">Not recorded</option>
              {PAYMENT_METHODS.map((method) => (
                <option key={method.value} value={method.value}>
                  {method.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tax treatment">
            <select
              name="taxCategory"
              defaultValue={editingExpense?.taxCategory ?? "UNSPECIFIED"}
              className={selectClass}
            >
              {TAX_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {TAX_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </Field>
          {mode === "recurring" || editingExpense?.recurring ? (
            <Field label="Recurring note">
              <Input
                name="recurringNote"
                placeholder="e.g. Monthly software"
                defaultValue={editingExpense?.recurringNote ?? ""}
              />
            </Field>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="recurring" value="1" className="size-4" />
              Recurring (identify only — not billed automatically)
            </label>
          )}
          {(mode === "recurring" || editingExpense?.recurring) && mode !== "recurring" ? (
            <input type="hidden" name="recurring" value="1" />
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="reimbursable"
              value="1"
              defaultChecked={Boolean(editingExpense?.reimbursable)}
              className="size-4"
            />
            Reimbursable to employee
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="customerBillable"
              value="1"
              defaultChecked={Boolean(editingExpense?.customerBillable)}
              className="mt-0.5 size-4"
            />
            <span>
              Potentially billable to the customer
              <span className="block text-xs text-muted-foreground">
                Does not add this expense to an invoice.
              </span>
            </span>
          </label>
          <Field label="Notes">
            <Input name="notes" placeholder="Optional notes" defaultValue={editingExpense?.notes ?? ""} />
          </Field>
          {editing ? null : storageConfigured ? (
            <Field label="Receipt">
              <Input type="file" name="receipt" accept="image/*" />
            </Field>
          ) : (
            <p className="text-xs text-muted-foreground">
              Receipt upload is unavailable until Vercel Blob storage is connected.
            </p>
          )}
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.message ? <p className="text-sm text-emerald-400">{state.message}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending
              ? "Saving…"
              : editing
                ? "Save changes"
                : recurring && mode !== "edit"
                  ? "Save recurring expense"
                  : "Save expense"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function MileageForm({
  open,
  onOpenChange,
  workers,
  jobs,
  defaultDate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workers: ExpenseWorkerOption[];
  jobs: ExpenseJobOption[];
  defaultDate: string;
}) {
  const [state, formAction, pending] = useActionState(createMileageExpenseAction, initialState);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add Mileage</SheetTitle>
          <SheetDescription>
            Store miles and the expense amount separately. TBBT does not invent an IRS or tax mileage rate — enter the amount yourself.
          </SheetDescription>
        </SheetHeader>
        <form action={formAction} className="mt-4 space-y-3 px-4 pb-6">
          <Field label="Date">
            <Input type="date" name="occurredOn" defaultValue={defaultDate} required />
          </Field>
          <Field label="Description">
            <Input name="description" defaultValue="Mileage" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Miles">
              <Input name="mileageMiles" inputMode="decimal" placeholder="0.0" required />
            </Field>
            <Field label="Amount">
              <Input name="amount" inputMode="decimal" placeholder="0.00" required />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Amount is required. No default per-mile rate is applied.
          </p>
          <Field label="Purchaser">
            <select name="purchaserMembershipId" defaultValue="" className={selectClass}>
              <option value="">Unassigned</option>
              {workers.map((worker) => (
                <option key={worker.membershipId} value={worker.membershipId}>
                  {worker.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Job (optional)">
            <select name="jobId" defaultValue="" className={selectClass}>
              <option value="">No job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.label}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="reimbursable" value="1" defaultChecked className="size-4" />
            Reimbursable to employee
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="customerBillable" value="1" className="mt-0.5 size-4" />
            <span>
              Potentially billable to the customer
              <span className="block text-xs text-muted-foreground">
                Does not add this expense to an invoice.
              </span>
            </span>
          </label>
          <Field label="Notes">
            <Input name="notes" placeholder="Optional notes" />
          </Field>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          {state.message ? <p className="text-sm text-emerald-400">{state.message}</p> : null}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Saving…" : "Save mileage"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function AttachReceiptForm({
  open,
  onOpenChange,
  expenseId,
  storageConfigured,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expenseId: string;
  storageConfigured: boolean;
}) {
  const [state, formAction, pending] = useActionState(attachExpenseReceiptAction, initialState);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Upload Receipt</SheetTitle>
          <SheetDescription>Attach a receipt image to this expense.</SheetDescription>
        </SheetHeader>
        {storageConfigured ? (
          <form action={formAction} className="mt-4 space-y-3 px-4 pb-6">
            <input type="hidden" name="expenseId" value={expenseId} />
            <Field label="Receipt image">
              <Input type="file" name="receipt" accept="image/*" required />
            </Field>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            {state.message ? <p className="text-sm text-emerald-400">{state.message}</p> : null}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Uploading…" : "Attach receipt"}
            </Button>
          </form>
        ) : (
          <p className="mt-4 px-4 text-sm text-muted-foreground">
            Receipt storage isn&apos;t connected. Expenses can still be recorded without a receipt.
          </p>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
