/**
 * Customer-facing estimate document helpers for print/PDF.
 *
 * Estimate numbers and PDF filenames are derived from existing Estimate
 * rows — there is no estimateNumber column. The document is version-first
 * (same rule as the public customer estimate page) and must never expose
 * calculator rates, formulas, owner notes, margins, work-area intake
 * answers, or other internal-only fields.
 */
import { Prisma, type LineItemType, type PrismaClient } from "@prisma/client";
import { getBusinessDocumentLogoSrc } from "@/lib/business-branding";
import { splitLineDescription } from "@/lib/estimate-line-scope";
import { parseWorkAreaIntake } from "@/lib/work-area-intake";
import {
  collectEstimateTermContext,
  resolveEstimateDocumentTerms,
} from "@/lib/estimate-terms/compose";
import {
  PROJECT_CONDITIONS_TITLE,
  TERMS_AND_CONDITIONS_TITLE,
} from "@/lib/estimate-terms/types";
import { formatAddress, formatDate, formatMoney } from "@/lib/format";
import {
  INVOICE_DOCUMENT_LOGO_HEIGHT_PX,
  sanitizeFilenamePart,
} from "@/lib/invoice-document";
import {
  MATERIAL_DEPOSIT_CUSTOMER_LABEL,
  MATERIAL_DEPOSIT_CUSTOMER_NOTE,
  REMAINING_BALANCE_CUSTOMER_LABEL,
  resolveMaterialDeposit,
} from "@/lib/material-deposit";
import { resolveCustomerMaterialsTotal } from "@/lib/customer-materials-total";
import { prisma } from "@/lib/prisma";
import { publicPhone } from "@/lib/public-site";
import { loadEstimatePaymentSummary } from "@/lib/project-payments";

const ZERO = new Prisma.Decimal(0);

export const ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX = INVOICE_DOCUMENT_LOGO_HEIGHT_PX;

export const LABOR_MINIMUM_CUSTOMER_LABEL =
  "Labor Minimum Service Fee Adjustment";

export const ESTIMATE_LABOR_SECTION_TITLE = "LABOR";
export const ESTIMATE_MATERIALS_SECTION_TITLE = "MATERIALS";
export const ESTIMATE_OTHER_SECTION_TITLE = "OTHER";
export const ESTIMATE_TOTAL_CUSTOMER_LABEL = "Estimate Total";

export function estimateNumberFromId(estimateId: string): string {
  return `EST-${estimateId.slice(-8).toUpperCase()}`;
}

export function estimatePdfFilename(
  estimateNumber: string,
  customerName?: string | null,
): string {
  return `Estimate-${sanitizeFilenamePart(estimateNumber)}-${sanitizeFilenamePart(
    customerName?.trim() || "Customer",
  )}.pdf`;
}

export function estimateStatusLabel(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft";
    case "SENT":
      return "Sent";
    case "APPROVED":
      return "Approved";
    default:
      return status;
  }
}

export type EstimateDocumentLine = {
  type: LineItemType;
  description: string;
  includedWork?: string | null;
  quantityLabel: string;
  unitPriceLabel: string;
  amountLabel: string;
  showLinePricing: boolean;
};

export type EstimateDocumentPolicy = {
  id?: string;
  title: string;
  body: string;
};

export type EstimateDocumentView = {
  estimateId: string;
  businessId: string;
  publicToken: string;
  estimateNumber: string;
  status: string;
  statusLabel: string;
  estimateDateLabel: string;
  pdfFilename: string;
  business: {
    name: string;
    slug: string;
    logoSrc: string | null;
    phone: string | null;
  };
  customer: {
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  serviceAddress: string | null;
  currentVersionId: string | null;
  lineItems: EstimateDocumentLine[];
  laborLines: EstimateDocumentLine[];
  materialLines: EstimateDocumentLine[];
  otherLines: EstimateDocumentLine[];
  policies: EstimateDocumentPolicy[];
  projectConditions: EstimateDocumentPolicy | null;
  terms: EstimateDocumentPolicy[];
  laborTotalLabel: string;
  materialTotalLabel: string;
  otherTotalLabel: string | null;
  subtotalLabel: string;
  laborMinimumLabel: string | null;
  laborMinimumAmountLabel: string | null;
  totalLabel: string;
  materialDepositLabel: string | null;
  remainingBalanceLabel: string | null;
  materialDepositNote: string | null;
  depositStatus: "none" | "due" | "partial" | "paid";
  depositPaidLabel: string | null;
  depositRemainingDueLabel: string | null;
  remainingProjectBalanceLabel: string | null;
};

const ESTIMATE_DOCUMENT_INCLUDE = {
  business: { select: { id: true, name: true, slug: true } },
  customer: { select: { id: true, name: true, email: true, phone: true } },
  property: {
    select: {
      addressLine1: true,
      addressLine2: true,
      city: true,
      region: true,
      postalCode: true,
    },
  },
  serviceRequest: { select: { description: true } },
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
  versions: {
    orderBy: { versionNumber: "desc" as const },
    take: 1,
    select: {
      id: true,
      sentAt: true,
      createdAt: true,
      total: true,
      laborMinimumAdjustment: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
      propertyAddressLine1: true,
      propertyAddressLine2: true,
      propertyCity: true,
      propertyRegion: true,
      propertyPostalCode: true,
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
    },
  },
} as const;

function formatQuantity(quantity: Prisma.Decimal): string {
  return quantity.toString();
}

function toDocumentPolicy(policy: {
  id?: string;
  title: string;
  body: string;
}): EstimateDocumentPolicy {
  return {
    ...(policy.id ? { id: policy.id } : {}),
    title: policy.title,
    body: policy.body,
  };
}

function toDocumentLines(
  lineItems: Array<{
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    total: Prisma.Decimal;
    type: LineItemType;
  }>,
): EstimateDocumentLine[] {
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

function toDocumentView(estimate: {
  id: string;
  publicToken: string;
  status: string;
  total: Prisma.Decimal;
  laborMinimumAdjustment: Prisma.Decimal;
  createdAt: Date;
  business: { id: string; name: string; slug: string };
  customer: {
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
  property: {
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
  } | null;
  lineItems: Array<{
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    total: Prisma.Decimal;
    type: LineItemType;
  }>;
  serviceRequest?: { description: string | null } | null;
  versions: Array<{
    id: string;
    sentAt: Date;
    createdAt: Date;
    total: Prisma.Decimal;
    laborMinimumAdjustment: Prisma.Decimal;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    propertyAddressLine1: string | null;
    propertyAddressLine2: string | null;
    propertyCity: string | null;
    propertyRegion: string | null;
    propertyPostalCode: string | null;
    lineItems: Array<{
      description: string;
      quantity: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
      total: Prisma.Decimal;
      type: LineItemType;
    }>;
  }>;
}): EstimateDocumentView {
  const currentVersion = estimate.versions[0] ?? null;
  const total = currentVersion?.total ?? estimate.total;
  const laborMinimumAdjustment =
    currentVersion?.laborMinimumAdjustment ?? estimate.laborMinimumAdjustment;
  const rawLines = currentVersion?.lineItems ?? estimate.lineItems;
  const customerName = currentVersion?.customerName ?? estimate.customer?.name ?? null;
  const customerEmail =
    currentVersion?.customerEmail ?? estimate.customer?.email ?? null;
  const customerPhone =
    currentVersion?.customerPhone ?? estimate.customer?.phone ?? null;
  const property = currentVersion
    ? currentVersion.propertyAddressLine1
      ? {
          addressLine1: currentVersion.propertyAddressLine1,
          addressLine2: currentVersion.propertyAddressLine2,
          city: currentVersion.propertyCity,
          region: currentVersion.propertyRegion,
          postalCode: currentVersion.propertyPostalCode,
        }
      : null
    : estimate.property;
  const estimateDate = currentVersion?.sentAt ?? currentVersion?.createdAt ?? estimate.createdAt;
  const estimateNumber = estimateNumberFromId(estimate.id);
  const showLaborMinimum = laborMinimumAdjustment.gt(0);
  const laborTotal = rawLines
    .filter((line) => line.type === "LABOR")
    .reduce((sum, line) => sum.add(line.total), ZERO);
  const materials = resolveCustomerMaterialsTotal(rawLines);
  const materialTotal = materials.amount;
  const otherTotal = rawLines
    .filter((line) => line.type === "OTHER")
    .reduce((sum, line) => sum.add(line.total), ZERO);
  const lineItems = toDocumentLines(rawLines);
  const deposit = resolveMaterialDeposit({ lines: rawLines, total });
  const showDeposit = deposit.amount.gt(0);
  const subtotal = laborTotal.add(materialTotal).add(otherTotal);
  const freezeSnapshot = Boolean(currentVersion) || estimate.status !== "DRAFT";
  const context = collectEstimateTermContext(rawLines);
  const resolvedTerms = resolveEstimateDocumentTerms({
    existing: context.existing,
    titles: context.titles,
    takeoffType: context.takeoffType,
    calculatorId: context.calculatorId,
    intake: freezeSnapshot
      ? undefined
      : parseWorkAreaIntake(estimate.serviceRequest?.description),
    hasMaterials: context.hasMaterials,
    hasDeposit: showDeposit,
    freezeSnapshot,
  });
  const policies = resolvedTerms.visible.map(toDocumentPolicy);

  return {
    estimateId: estimate.id,
    businessId: estimate.business.id,
    publicToken: estimate.publicToken,
    estimateNumber,
    status: estimate.status,
    statusLabel: estimateStatusLabel(estimate.status),
    estimateDateLabel: formatDate(estimateDate),
    pdfFilename: estimatePdfFilename(estimateNumber, customerName),
    business: {
      name: estimate.business.name,
      slug: estimate.business.slug,
      logoSrc: getBusinessDocumentLogoSrc(estimate.business.slug),
      phone: publicPhone(estimate.business.slug),
    },
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    },
    serviceAddress: property ? formatAddress(property) : null,
    currentVersionId: currentVersion?.id ?? null,
    lineItems,
    laborLines: lineItems.filter((line) => line.type === "LABOR"),
    materialLines: lineItems.filter((line) => line.type === "MATERIAL"),
    otherLines: lineItems.filter((line) => line.type === "OTHER"),
    policies,
    projectConditions: resolvedTerms.projectConditions
      ? toDocumentPolicy(resolvedTerms.projectConditions)
      : null,
    terms: resolvedTerms.terms.map(toDocumentPolicy),
    laborTotalLabel: formatMoney(laborTotal),
    materialTotalLabel: formatMoney(materialTotal),
    otherTotalLabel: otherTotal.gt(0) ? formatMoney(otherTotal) : null,
    subtotalLabel: formatMoney(subtotal),
    laborMinimumLabel: showLaborMinimum ? LABOR_MINIMUM_CUSTOMER_LABEL : null,
    laborMinimumAmountLabel: showLaborMinimum
      ? formatMoney(laborMinimumAdjustment)
      : null,
    totalLabel: formatMoney(total),
    materialDepositLabel: showDeposit ? formatMoney(deposit.amount) : null,
    remainingBalanceLabel: showDeposit ? formatMoney(deposit.remaining) : null,
    materialDepositNote: showDeposit ? MATERIAL_DEPOSIT_CUSTOMER_NOTE : null,
    depositStatus: showDeposit ? "due" : "none",
    depositPaidLabel: null,
    depositRemainingDueLabel: showDeposit ? formatMoney(deposit.amount) : null,
    remainingProjectBalanceLabel: showDeposit
      ? formatMoney(deposit.remaining)
      : formatMoney(total),
  };
}

async function withPaymentSummary(
  estimate: {
    id: string;
    businessId: string;
    total: Prisma.Decimal;
    lineItems: Array<{ type: string; total: Prisma.Decimal; description: string }>;
    versions?: Array<{
      total: Prisma.Decimal;
      lineItems: Array<{ type: string; total: Prisma.Decimal; description: string }>;
    }>;
  },
  document: EstimateDocumentView,
  db: PrismaClient,
): Promise<EstimateDocumentView> {
  const version = estimate.versions?.[0];
  const lines = version?.lineItems ?? estimate.lineItems;
  const total = version?.total ?? estimate.total;
  const deposit = resolveMaterialDeposit({ lines, total });
  if (deposit.amount.lte(0)) return document;
  const summary = await loadEstimatePaymentSummary(db, {
    businessId: estimate.businessId,
    estimateId: estimate.id,
    estimateTotal: total,
    requiredDeposit: deposit.amount,
  });
  return {
    ...document,
    depositStatus: summary.depositStatus,
    depositPaidLabel: formatMoney(summary.depositPaid),
    depositRemainingDueLabel: formatMoney(summary.depositRemaining),
    remainingProjectBalanceLabel: formatMoney(summary.remainingBalance),
    remainingBalanceLabel: formatMoney(summary.remainingBalance),
  };
}

function sectionPlainText(title: string, lines: EstimateDocumentLine[]) {
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

export function estimateDocumentPlainText(document: EstimateDocumentView): string {
  const lines = [
    document.business.name,
    document.business.phone ?? "",
    "ESTIMATE",
    document.estimateNumber,
    document.estimateDateLabel,
    document.statusLabel,
    document.customer.name ?? "",
    document.customer.email ?? "",
    document.customer.phone ?? "",
    document.serviceAddress ?? "",
    ...sectionPlainText(ESTIMATE_LABOR_SECTION_TITLE, document.laborLines),
    ...sectionPlainText(ESTIMATE_MATERIALS_SECTION_TITLE, document.materialLines),
    ...sectionPlainText(ESTIMATE_OTHER_SECTION_TITLE, document.otherLines),
    "Labor",
    document.laborTotalLabel,
    "Materials",
    document.materialTotalLabel,
    document.otherTotalLabel ?? "",
    document.subtotalLabel,
    document.laborMinimumLabel ?? "",
    document.laborMinimumAmountLabel ?? "",
    ESTIMATE_TOTAL_CUSTOMER_LABEL,
    document.totalLabel,
    document.materialDepositLabel
      ? MATERIAL_DEPOSIT_CUSTOMER_LABEL
      : "",
    document.materialDepositLabel ?? "",
    document.remainingBalanceLabel
      ? REMAINING_BALANCE_CUSTOMER_LABEL
      : "",
    document.remainingBalanceLabel ?? "",
    document.materialDepositNote ?? "",
    document.projectConditions ? PROJECT_CONDITIONS_TITLE : "",
    document.projectConditions?.title ?? "",
    document.projectConditions?.body ?? "",
    document.terms.length > 0 ? TERMS_AND_CONDITIONS_TITLE : "",
    ...document.terms.flatMap((policy) => [policy.title, policy.body]),
    ...document.policies.flatMap((policy) => [policy.title, policy.body]),
  ];
  return lines.filter(Boolean).join("\n");
}

export async function loadEstimateDocumentForBusiness(
  estimateId: string,
  businessId: string,
  db: PrismaClient = prisma,
): Promise<EstimateDocumentView | null> {
  if (!estimateId || !businessId) {
    return null;
  }

  const estimate = await db.estimate.findFirst({
    where: { id: estimateId, businessId },
    include: ESTIMATE_DOCUMENT_INCLUDE,
  });

  return estimate
    ? withPaymentSummary(estimate, toDocumentView(estimate), db)
    : null;
}

export async function loadEstimateDocumentByToken(
  token: string,
  db: PrismaClient = prisma,
): Promise<EstimateDocumentView | null> {
  if (!token) {
    return null;
  }

  const estimate = await db.estimate.findUnique({
    where: { publicToken: token },
    include: ESTIMATE_DOCUMENT_INCLUDE,
  });

  return estimate
    ? withPaymentSummary(estimate, toDocumentView(estimate), db)
    : null;
}
