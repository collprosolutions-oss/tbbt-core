/**
 * OWNER collections worklist.
 *
 * Page load is read/explain only. Unpaid balances come from recorded
 * Invoice + Payment rows. Contact state comes from recorded
 * CustomerCommunication rows. OWNER may record a next step or
 * resolution without changing payment status or sending a reminder.
 */

export const COLLECTIONS_ROUTE = "/invoices/collections";

export const COLLECTIONS_QUEUE_LIMIT = 40;
export const COLLECTIONS_SCAN_LIMIT = 120;
export const COLLECTIONS_COMMUNICATION_SCAN_LIMIT = 80;
export const COLLECTIONS_NOTE_MAX_CHARS = 500;

export const COLLECTIONS_WORK_ITEM_LOCK_PREFIX = "invoice-collection-work-item";

export const COLLECTIONS_STATUSES = ["OPEN", "RESOLVED"] as const;
export type CollectionsWorkItemStatus = (typeof COLLECTIONS_STATUSES)[number];

export const COLLECTIONS_NEXT_STEPS = ["CALL", "EMAIL", "WAIT", "OTHER"] as const;
export type CollectionsNextStep = (typeof COLLECTIONS_NEXT_STEPS)[number];

export const COLLECTIONS_NEXT_STEP_LABELS: Record<CollectionsNextStep, string> = {
  CALL: "Call",
  EMAIL: "Email",
  WAIT: "Wait",
  OTHER: "Other",
};

export const COLLECTIONS_READ_ONLY_MESSAGE =
  "This worklist uses recorded invoices, recorded payments, and recorded communication history only. Page load does not send reminders, mark invoices paid, or write payments.";

export const COLLECTIONS_BALANCE_MESSAGE =
  "Unpaid balance is the invoice total minus attributed recorded payments. Banking is Not Connected. No bank deposit is inferred.";

export const COLLECTIONS_NO_DUE_DATE_MESSAGE =
  "Invoice has no due-date field. Age is days since the recorded invoice date. Overdue is not invented.";

export const COLLECTIONS_OWNER_NEXT_STEP_MESSAGE =
  "An owner can record a manual next step on an unpaid invoice. This action does not send SMS or email and does not change payment status.";

export const COLLECTIONS_OWNER_RESOLVE_MESSAGE =
  "An owner can record a collections resolution without marking the invoice paid. This action does not send SMS or email and does not write a payment.";

export const COLLECTIONS_NEXT_STEP_RECORDED_MESSAGE =
  "Next step recorded. It has not been sent. Payment status is unchanged.";

export const COLLECTIONS_NEXT_STEP_UPDATED_MESSAGE =
  "Next step updated. It has not been sent. Payment status is unchanged.";

export const COLLECTIONS_RESOLVED_MESSAGE =
  "Collections resolution recorded. The invoice was not marked paid and no reminder was sent.";

export const COLLECTIONS_RESOLUTION_UNCHANGED_MESSAGE =
  "That collections resolution is already on file. Payment status is unchanged.";

export const COLLECTIONS_OWNER_ONLY_MESSAGE = "Only the business owner can record collections work.";

export const COLLECTIONS_UNKNOWN_INVOICE_MESSAGE = "That invoice is not in this business.";

export const COLLECTIONS_NOT_UNPAID_MESSAGE =
  "Only a sent invoice with a recorded unpaid balance can be updated here.";

export const COLLECTIONS_UNKNOWN_NEXT_STEP_MESSAGE = "Choose a recorded next step.";

export const COLLECTIONS_NOTE_TOO_LONG_MESSAGE = "Keep the note under 500 characters.";

export const COLLECTIONS_UNAVAILABLE_MESSAGE =
  "Collections next steps are unavailable on this environment until the collections migration is applied. Unpaid balances from recorded invoices still use recorded payments.";

export const COLLECTIONS_OVERFLOW_MESSAGE =
  "Invoice reads hit the collections bound, so this list is a bounded sample of unpaid sent invoices, not a complete ledger.";

export const COLLECTIONS_NO_CONTACT_LABEL = "No recorded contact";

export const BANK_NOT_CONNECTED_COLLECTIONS_MESSAGE =
  "TBBT does not have an actual bank balance. Banking is Not Connected. No deposit is inferred from a bank feed.";
