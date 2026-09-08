/**
 * Customer-facing invoice document helpers.
 *
 * Invoice numbers and PDF filenames are derived from existing Invoice
 * rows — there is no invoiceNumber / dueDate / tax column. Do not invent
 * those fields. Commercial content comes from the Invoice row and its
 * copied LineItem snapshots (see src/lib/invoice-carry-forward.ts).
 */
import { Prisma, type LineItemType, type PrismaClient } from "@prisma/client";
import { getBusinessDocumentLogoSrc } from "@/lib/business-branding";
import { resolveCustomerMaterialsTotal } from "@/lib/customer-materials-total";
import { splitLineDescription } from "@/lib/estimate-line-scope";
import { formatAddress, formatDate, formatMoney } from "@/lib/format";
import {
  backfillEmptyInvoiceWorkLines,
  toInvoiceDecimal,
} from "@/lib/invoice-carry-forward";
import { prisma } from "@/lib/prisma";
import { publicPhone } from "@/lib/public-site";
import {
  invoicePaymentBreakdown,
  listProjectPayments,
} from "@/lib/project-payments";

const ZERO = new Prisma.Decimal(0);

export const INVOICE_THANK_YOU = "Thank you for your business.";

/** Keeps the "WORK PERFORMED" substring used by existing invoice/PDF tests. */
export const INVOICE_LABOR_SECTION_TITLE = "LABOR / WORK PERFORMED";
export const INVOICE_MATERIALS_SECTION_TITLE = "MATERIALS";
export const INVOICE_OTHER_SECTION_TITLE = "OTHER";
export const INVOICE_TOTAL_CUSTOMER_LABEL = "Invoice Total";

/** Shared invoice/PDF header logo height. Tall enough to read COLL★PRO. */
export const INVOICE_DOCUMENT_LOGO_HEIGHT_PX = 108;

export function invoiceNumberFromId(invoiceId: string): string {
  return `INV-${invoiceId.slice(-8).toUpperCase()}`;
}

export function jobReferenceFromId(jobId: string): string {
  return `JOB-${jobId.slice(-8).toUpperCase()}`;
}

export function sanitizeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return cleaned || "invoice";
}

export function invoicePdfFilename(
  invoiceNumber: string,
  customerName?: string | null,
): string {
  return `Invoice-${sanitizeFilenamePart(invoiceNumber)}-${sanitizeFilenamePart(
    customerName?.trim() || "Customer",
  )}.pdf`;
}

export function invoiceStatusLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "SENT":
      return "Sent";
    case "PAID":
      return "Paid";
    default:
      return status;
  }
}

export function isCustomerVisibleInvoiceStatus(status: string): boolean {
  return status === "SENT" || status === "PAID";
}

export function invoiceAmountPaid(status: string, total: Prisma.Decimal): Prisma.Decimal {
  return status === "PAID" ? total : ZERO;
}

export function invoiceAmountDue(status: string, total: Prisma.Decimal): Prisma.Decimal {
  return status === "PAID" ? ZERO : total;
}

export type InvoiceDocumentLine = {
  type: LineItemType;
  description: string;
  includedWork?: string | null;
  quantityLabel: string;
  unitPriceLabel: string;
  amountLabel: string;
  showLinePricing: boolean;
};

export type InvoiceDocumentView = {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  statusLabel: string;
  invoiceDateLabel: string;
  paidAtLabel: string | null;
  pdfFilename: string;
  business: {
    name: string;
    logoSrc: string | null;
    phone: string | null;
  };
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  serviceAddress: string | null;
  jobReference: string | null;
  jobId: string | null;
  customerId: string | null;
  lineItems: InvoiceDocumentLine[];
  laborLines: InvoiceDocumentLine[];
  materialLines: InvoiceDocumentLine[];
  otherLines: InvoiceDocumentLine[];
  laborTotalLabel: string;
  materialTotalLabel: string | null;
  otherTotalLabel: string | null;
  /**
   * Always the frozen Invoice.total. Never the raw MATERIAL line sum.
   * Customer HTML/PDF do not render a Subtotal row.
   */
  subtotalLabel: string;
  totalLabel: string;
  amountPaidLabel: string;
  amountDueLabel: string;
  depositPaidLabel: string | null;
  otherPaymentsLabel: string | null;
  creditLabel: string | null;
  thankYou: string;
};

const INVOICE_DOCUMENT_INCLUDE = {
  business: { select: { id: true, name: true, slug: true } },
  customer: { select: { id: true, name: true, email: true, phone: true } },
  job: {
    select: {
      id: true,
      property: {
        select: {
          addressLine1: true,
          addressLine2: true,
          city: true,
          region: true,
          postalCode: true,
        },
      },
    },
  },
  lineItems: {
    orderBy: { createdAt: "asc" as const },
    select: {
      description: true,
      quantity: true,
      unitPrice: true,
      total: true,
      type: true,
    },
  },
} as const;

function formatQuantity(quantity: Prisma.Decimal): string {
  return quantity.toString();
}

function toDocumentLines(
  lineItems: Array<{
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    total: Prisma.Decimal;
    type: LineItemType;
  }>,
): InvoiceDocumentLine[] {
  return lineItems.map((line) => {
    const parts = splitLineDescription(line.description);
    const hideLinePricing = line.type === "MATERIAL";
    return {
      type: line.type,
      description: parts.title,
      includedWork: hideLinePricing ? null : parts.includedWork,
      quantityLabel: formatQuantity(line.quantity),
      unitPriceLabel: hideLinePricing ? "" : formatMoney(line.unitPrice),
      amountLabel: hideLinePricing ? "" : formatMoney(line.total),
      showLinePricing: !hideLinePricing,
    };
  });
}

function toDocumentView(
  invoice: {
    id: string;
    status: string;
    total: Prisma.Decimal;
    paidAt: Date | null;
    createdAt: Date;
    customerId: string | null;
    business: { name: string; slug: string };
    customer: { id: string; name: string; email: string | null; phone: string | null } | null;
    job: {
      id: string;
      property: {
        addressLine1: string;
        addressLine2: string | null;
        city: string | null;
        region: string | null;
        postalCode: string | null;
      } | null;
    } | null;
    lineItems: Array<{
      description: string;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      total: Prisma.Decimal;
      type: LineItemType;
    }>;
  },
  payments: Array<{ purpose: string; amount: Prisma.Decimal | number | string }> = [],
): InvoiceDocumentView {
  const invoiceNumber = invoiceNumberFromId(invoice.id);
  const customerName = invoice.customer?.name ?? null;
  const laborTotal = invoice.lineItems
    .filter((line) => line.type === "LABOR")
    .reduce((sum, line) => sum.add(line.total), ZERO);
  const materials = resolveCustomerMaterialsTotal(invoice.lineItems);
  const materialTotal = materials.amount;
  const otherTotal = invoice.lineItems
    .filter((line) => line.type === "OTHER")
    .reduce((sum, line) => sum.add(line.total), ZERO);
  const lineItems = toDocumentLines(invoice.lineItems);
  const laborLines = lineItems.filter((line) => line.type === "LABOR");
  const materialLines = lineItems.filter((line) => line.type === "MATERIAL");
  const otherLines = lineItems.filter((line) => line.type === "OTHER");
  const showMaterials = materialLines.length > 0 || materialTotal.gt(0);
  const showOther = otherLines.length > 0 || otherTotal.gt(0);
  const amount = invoicePaymentBreakdown({
    status: invoice.status,
    total: invoice.total,
    payments,
  });
  const amountPaid = amount.amountPaid;
  const amountDue = amount.amountDue;
  const serviceAddress = invoice.job?.property
    ? formatAddress(invoice.job.property)
    : null;
  const totalLabel = formatMoney(invoice.total);

  return {
    invoiceId: invoice.id,
    invoiceNumber,
    status: invoice.status,
    statusLabel: invoiceStatusLabel(invoice.status),
    invoiceDateLabel: formatDate(invoice.createdAt),
    paidAtLabel: invoice.paidAt ? formatDate(invoice.paidAt) : null,
    pdfFilename: invoicePdfFilename(invoiceNumber, customerName),
    business: {
      name: invoice.business.name,
      logoSrc: getBusinessDocumentLogoSrc(invoice.business.slug),
      phone: publicPhone(invoice.business.slug),
    },
    customer: {
      name: customerName,
      email: invoice.customer?.email ?? null,
      phone: invoice.customer?.phone ?? null,
    },
    serviceAddress,
    jobReference: invoice.job ? jobReferenceFromId(invoice.job.id) : null,
    jobId: invoice.job?.id ?? null,
    customerId: invoice.customerId,
    lineItems,
    laborLines,
    materialLines,
    otherLines,
    laborTotalLabel: formatMoney(laborTotal),
    materialTotalLabel: showMaterials ? formatMoney(materialTotal) : null,
    otherTotalLabel: showOther ? formatMoney(otherTotal) : null,
    subtotalLabel: totalLabel,
    totalLabel,
    amountPaidLabel: formatMoney(amountPaid),
    amountDueLabel: formatMoney(amountDue),
    depositPaidLabel:
      amount.depositPaid.gt(0) ? formatMoney(amount.depositPaid) : null,
    otherPaymentsLabel:
      amount.depositPaid.gt(0) && amount.otherPaid.gt(0)
        ? formatMoney(amount.otherPaid)
        : null,
    creditLabel: amount.credit.gt(0)
      ? `Credit on account ${formatMoney(amount.credit)}`
      : null,
    thankYou: INVOICE_THANK_YOU,
  };
}

export async function loadInvoiceDocumentForBusiness(
  invoiceId: string,
  businessId: string,
  db: PrismaClient = prisma,
): Promise<InvoiceDocumentView | null> {
  if (!invoiceId || !businessId) {
    return null;
  }

  const existing = await db.invoice.findFirst({
    where: { id: invoiceId, businessId },
    select: { id: true },
  });
  if (!existing) {
    return null;
  }

  await backfillEmptyInvoiceWorkLines(db, { businessId, invoiceId });

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, businessId },
    include: INVOICE_DOCUMENT_INCLUDE,
  });
  if (!invoice) return null;
  const payments = await listProjectPayments(db, {
    businessId,
    invoiceId: invoice.id,
    jobId: invoice.job?.id ?? null,
  });
  return toDocumentView(invoice, payments);
}

/**
 * Customer Project Portal loader. Scoped only by Job.projectToken.
 * DRAFT invoices are never returned — the owner has not sent them yet.
 */
export async function loadInvoiceDocumentForProjectToken(
  token: string,
  db: PrismaClient = prisma,
): Promise<InvoiceDocumentView | null> {
  if (!token) {
    return null;
  }

  const job = await db.job.findUnique({
    where: { projectToken: token },
    select: {
      invoices: {
        take: 1,
        orderBy: { createdAt: "asc" },
        select: { id: true, businessId: true, status: true },
      },
    },
  });

  const invoiceRef = job?.invoices[0];
  if (!invoiceRef || !isCustomerVisibleInvoiceStatus(invoiceRef.status)) {
    return null;
  }

  return loadInvoiceDocumentForBusiness(invoiceRef.id, invoiceRef.businessId, db);
}

export function invoiceLineSubtotal(
  lines: ReadonlyArray<{ total: Prisma.Decimal | number | string }>,
): Prisma.Decimal {
  return lines.reduce(
    (sum, line) => sum.add(toInvoiceDecimal(line.total)),
    ZERO,
  );
}

function sectionPlainText(title: string, lines: InvoiceDocumentLine[]) {
  if (lines.length === 0) return [];
  const quantityOnly = lines.every((line) => !line.showLinePricing);
  return [
    title,
    ...(quantityOnly ? ["Description", "Qty"] : []),
    ...lines.flatMap((line) =>
      line.showLinePricing
        ? [
            line.description,
            line.includedWork ?? "",
            line.quantityLabel,
            line.unitPriceLabel,
            line.amountLabel,
          ]
        : [line.description, line.quantityLabel],
    ),
  ];
}

export function invoiceDocumentPlainText(document: InvoiceDocumentView): string {
  const lines = [
    document.business.name,
    document.business.phone ?? "",
    "INVOICE",
    document.invoiceNumber,
    document.invoiceDateLabel,
    document.statusLabel,
    document.customer.name ?? "",
    document.customer.email ?? "",
    document.customer.phone ?? "",
    document.serviceAddress ?? "",
    ...sectionPlainText(INVOICE_LABOR_SECTION_TITLE, document.laborLines),
    ...sectionPlainText(INVOICE_MATERIALS_SECTION_TITLE, document.materialLines),
    ...sectionPlainText(INVOICE_OTHER_SECTION_TITLE, document.otherLines),
    "Labor",
    document.laborTotalLabel,
    document.materialTotalLabel ? "Materials" : "",
    document.materialTotalLabel ?? "",
    document.otherTotalLabel ? "Other" : "",
    document.otherTotalLabel ?? "",
    INVOICE_TOTAL_CUSTOMER_LABEL,
    document.totalLabel,
    "Payments",
    document.amountPaidLabel,
    document.depositPaidLabel ? "Deposit Paid" : "",
    document.depositPaidLabel ? `-${document.depositPaidLabel}` : "",
    "Amount Due",
    document.amountDueLabel,
    document.thankYou,
    document.jobReference ?? "",
  ];
  return lines.filter(Boolean).join("\n");
}
