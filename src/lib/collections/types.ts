import type { CollectionsNextStep, CollectionsWorkItemStatus } from "@/lib/collections/constants";

export type CollectionsRecordedContact = {
  occurredAt: string;
  channel: string;
  purpose: string;
  status: string;
  direction: string;
  relatedToThisInvoice: boolean;
};

export type CollectionsRecordedWorkItem = {
  id: string;
  status: CollectionsWorkItemStatus;
  nextStep: CollectionsNextStep | null;
  nextStepLabel: string | null;
  note: string;
  resolvedAt: string | null;
};

export type CollectionsWorklistItem = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceHref: string;
  customerId: string | null;
  customerName: string;
  customerHref: string | null;
  communicationsHref: string | null;
  status: "SENT";
  invoiceTotal: string;
  amountPaid: string;
  amountDue: string;
  invoiceTotalLabel: string;
  amountPaidLabel: string;
  amountDueLabel: string;
  issuedAt: string;
  ageDays: number;
  agingBucket: string;
  dueDate: null;
  contact: CollectionsRecordedContact | null;
  workItem: CollectionsRecordedWorkItem | null;
};

export type CollectionsWorklist = {
  businessId: string;
  timeZone: string;
  queueLimit: number;
  scanLimit: number;
  overflow: boolean;
  scannedInvoiceCount: number;
  unpaidCount: number;
  items: CollectionsWorklistItem[];
  readOnly: true;
  mutationsOnLoad: false;
  unavailable: boolean;
};
