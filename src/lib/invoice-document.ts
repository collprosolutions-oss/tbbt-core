/**
 * Customer-facing invoice document helpers.
 *
 * Invoice numbers and PDF filenames are derived from existing Invoice
 * rows — there is no invoiceNumber / dueDate / tax column. Do not invent
 * those fields. Commercial content comes from the Invoice row and its
 * copied LineItem snapshots (see src/lib/invoice-carry-forward.ts).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { getBusinessDocumentLogoSrc } from "@/lib/business-branding";
import { formatAddress, formatDate, formatMoney } from "@/lib/format";
import { toInvoiceDecimal } from "@/lib/invoice-carry-forward";
import { prisma } from "@/lib/prisma";
import { publicPhone } from "@/lib/public-site";

const ZERO = new Prisma.Decimal(0);

export const INVOICE_THANK_YOU = "Thank you for your business.";

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
  description: string;
  quantityLabel: string;
  unitPriceLabel: string;
  amountLabel: string;
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
  subtotalLabel: string;
  totalLabel: string;
  amountPaidLabel: string;
  amountDueLabel: string;
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
    },
  },
} as const;

function formatQuantity(quantity: Prisma.Decimal): string {
  return quantity.toString();
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
    }>;
  },
): InvoiceDocumentView {
  const invoiceNumber = invoiceNumberFromId(invoice.id);
  const customerName = invoice.customer?.name ?? null;
  const subtotal = invoice.lineItems.reduce(
    (sum, line) => sum.add(line.total),
    ZERO,
  );
  const amountPaid = invoiceAmountPaid(invoice.status, invoice.total);
  const amountDue = invoiceAmountDue(invoice.status, invoice.total);
  const serviceAddress = invoice.job?.property
    ? formatAddress(invoice.job.property)
    : null;

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
    lineItems: invoice.lineItems.map((line) => ({
      description: line.description,
      quantityLabel: formatQuantity(line.quantity),
      unitPriceLabel: formatMoney(line.unitPrice),
      amountLabel: formatMoney(line.total),
    })),
    subtotalLabel: formatMoney(subtotal),
    totalLabel: formatMoney(invoice.total),
    amountPaidLabel: formatMoney(amountPaid),
    amountDueLabel: formatMoney(amountDue),
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

  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, businessId },
    include: INVOICE_DOCUMENT_INCLUDE,
  });

  return invoice ? toDocumentView(invoice) : null;
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
