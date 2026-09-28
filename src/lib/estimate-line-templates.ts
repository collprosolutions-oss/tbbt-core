/**
 * OWNER-named, business-scoped reusable draft estimate line sets.
 *
 * Templates store LABOR / MATERIAL / OTHER snapshots only. They never
 * write public catalog prices, never advertise hourly public rates, and
 * never mutate SENT / APPROVED estimates. Apply copies lines onto a
 * DRAFT so the owner can review and edit before sending.
 */
import { Prisma } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import { isHourlyUnitLabel } from "@/lib/estimate-calculators/unit-registry";
import {
  joinLineDescription,
  splitLineDescription,
} from "@/lib/estimate-line-scope";

export const ESTIMATE_LINE_TEMPLATE_KIND = "estimate-line-template" as const;
export const MAX_TEMPLATE_NAME_LENGTH = 80;
export const MAX_TEMPLATE_LINES = 20;
export const TEMPLATE_LIST_BOUND = 40;

export const TEMPLATE_LINE_TYPES = ["LABOR", "MATERIAL", "OTHER"] as const;
export type TemplateLineType = (typeof TEMPLATE_LINE_TYPES)[number];

export const NAME_REQUIRED_MESSAGE = "Name the estimate template before saving.";
export const DUPLICATE_TEMPLATE_NAME_MESSAGE =
  "That template name is already used in this workspace.";
export const EMPTY_TEMPLATE_LINES_MESSAGE =
  "Add at least one labor, material, or other draft line before saving a template.";
export const TEMPLATE_LINE_BOUND_MESSAGE = `A template can store at most ${MAX_TEMPLATE_LINES} draft lines.`;
export const TEMPLATE_LIST_BOUND_MESSAGE =
  "Saved template reads hit the bound, so this list is a bounded sample.";
export const TEMPLATE_NOT_FOUND_MESSAGE =
  "That estimate template is not in this workspace.";
export const DRAFT_ONLY_APPLY_MESSAGE =
  "Apply a template only to a draft estimate. Approved and sent estimates stay unchanged.";
export const DRAFT_ONLY_SAVE_MESSAGE =
  "Save a template from a draft estimate. Sent and approved estimates stay unchanged.";
export const NO_CATALOG_PRICE_WRITE_MESSAGE =
  "Saving or applying a template does not change public catalog prices.";
export const NO_APPROVED_CHANGE_MESSAGE =
  "Templates never change approved estimates.";
export const REVIEW_BEFORE_SEND_MESSAGE =
  "Review and edit the resulting draft estimate before sending.";
export const NO_PUBLIC_HOURLY_PRICE_MESSAGE =
  "Templates stay inside this business and do not publish hourly prices.";
export const HOURLY_TEMPLATE_LINE_MESSAGE =
  "Template lines cannot advertise hourly pricing. Use a job price, not a public hourly rate.";
export const INVALID_TEMPLATE_LINE_MESSAGE =
  "Each template line needs a description, a quantity greater than zero, and Labor, Material, or Other.";
export const TEMPLATE_UNAVAILABLE_MESSAGE =
  "Named estimate templates are unavailable on this environment until the template migration is applied.";

export type EstimateLineTemplateSnapshotLine = {
  sortOrder: number;
  type: TemplateLineType;
  description: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
};

export type SavedEstimateLineTemplate = {
  id: string;
  businessId: string;
  name: string;
  kind: typeof ESTIMATE_LINE_TEMPLATE_KIND;
  lineCount: number;
  lines: EstimateLineTemplateSnapshotLine[];
  writesCatalogPrices: false;
  appliesToApprovedEstimates: false;
};

export function canAccessEstimateLineTemplates(
  role: BusinessAccess["workspace"]["role"],
): boolean {
  return role === "OWNER" && canAccessManagementConsole(role);
}

export function assertCanManageEstimateLineTemplates(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  requireBusinessRole(access, "OWNER");
}

export function parseTemplateName(raw: string | null | undefined): {
  name: string | null;
  error: string | null;
} {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { name: null, error: NAME_REQUIRED_MESSAGE };
  if (name.length > MAX_TEMPLATE_NAME_LENGTH) {
    return {
      name: null,
      error: `Template name must be ${MAX_TEMPLATE_NAME_LENGTH} characters or fewer.`,
    };
  }
  return { name, error: null };
}

export function isTemplateLineType(value: unknown): value is TemplateLineType {
  return (
    typeof value === "string" &&
    (TEMPLATE_LINE_TYPES as readonly string[]).includes(value)
  );
}

function parseMoney(raw: unknown, label: string, allowZero: boolean) {
  const text =
    raw == null
      ? ""
      : typeof raw === "string"
        ? raw.trim()
        : typeof raw === "number"
          ? String(raw)
          : typeof raw === "object" && raw !== null && "toString" in raw
            ? String(raw.toString()).trim()
            : "";
  if (!text) {
    throw new Error(`Enter a ${label}.`);
  }
  try {
    const value = new Prisma.Decimal(text);
    if (value.isNaN() || value.lt(0) || (!allowZero && value.lte(0))) {
      throw new Error(
        allowZero ? `Enter a valid ${label}.` : `Enter a ${label} greater than zero.`,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Enter")) throw error;
    throw new Error(`Enter a valid ${label}.`);
  }
}

export function snapshotDraftLineForTemplate(line: {
  type: string;
  description: string;
  quantity: Prisma.Decimal | string | number;
  unitPrice: Prisma.Decimal | string | number;
}): EstimateLineTemplateSnapshotLine | { skip: true } | { error: string } {
  if (!isTemplateLineType(line.type)) {
    return { skip: true };
  }
  const parts = splitLineDescription(line.description);
  const title = parts.title.trim();
  if (!title) return { skip: true };
  if (parts.materialDeposit && !parts.includedWork && /material deposit/i.test(title)) {
    return { skip: true };
  }
  if (parts.customerMaterialsTotal && !parts.includedWork && /materials total/i.test(title)) {
    return { skip: true };
  }
  if (isHourlyUnitLabel(title)) {
    return { error: HOURLY_TEMPLATE_LINE_MESSAGE };
  }
  let quantity: Prisma.Decimal;
  let unitPrice: Prisma.Decimal;
  try {
    quantity = parseMoney(line.quantity, "quantity", false);
    unitPrice = parseMoney(line.unitPrice, "price", true);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : INVALID_TEMPLATE_LINE_MESSAGE,
    };
  }
  return {
    sortOrder: 0,
    type: line.type,
    description: joinLineDescription(
      title,
      line.type === "MATERIAL" ? null : parts.includedWork,
    ),
    quantity,
    unitPrice,
  };
}

export function collectTemplateLines(
  lines: Array<{
    type: string;
    description: string;
    quantity: Prisma.Decimal | string | number;
    unitPrice: Prisma.Decimal | string | number;
  }>,
): { lines: EstimateLineTemplateSnapshotLine[]; error: string | null } {
  const next: EstimateLineTemplateSnapshotLine[] = [];
  for (const line of lines) {
    const snapshot = snapshotDraftLineForTemplate(line);
    if ("error" in snapshot) return { lines: [], error: snapshot.error };
    if ("skip" in snapshot) continue;
    next.push({ ...snapshot, sortOrder: next.length });
    if (next.length > MAX_TEMPLATE_LINES) {
      return { lines: [], error: TEMPLATE_LINE_BOUND_MESSAGE };
    }
  }
  if (next.length === 0) {
    return { lines: [], error: EMPTY_TEMPLATE_LINES_MESSAGE };
  }
  return { lines: next, error: null };
}

export function toSavedEstimateLineTemplate(row: {
  id: string;
  businessId: string;
  name: string;
  lines?: Array<{
    sortOrder: number;
    type: string;
    description: string;
    quantity: Prisma.Decimal | { toString(): string };
    unitPrice: Prisma.Decimal | { toString(): string };
  }>;
}): SavedEstimateLineTemplate {
  const lines = (row.lines ?? [])
    .filter((line) => isTemplateLineType(line.type))
    .slice()
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((line, index) => ({
      sortOrder: index,
      type: line.type as TemplateLineType,
      description: line.description,
      quantity: new Prisma.Decimal(line.quantity.toString()),
      unitPrice: new Prisma.Decimal(line.unitPrice.toString()),
    }));
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    kind: ESTIMATE_LINE_TEMPLATE_KIND,
    lineCount: lines.length,
    lines,
    writesCatalogPrices: false,
    appliesToApprovedEstimates: false,
  };
}

export function isolateSameBusinessTemplates<T extends { businessId: string }>(
  rows: T[],
  businessId: string,
): T[] {
  return rows.filter((row) => row.businessId === businessId);
}
