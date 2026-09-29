/**
 * OWNER-authored priced alternatives on a DRAFT estimate.
 *
 * Zero options is a single-option estimate (existing send / approve / job
 * behavior). Two or three options is the only multi-option shape. Sending
 * freezes options onto EstimateVersionOption. The customer must choose
 * one through approveEstimate(). Only that frozen option may flow to a Job.
 *
 * This module never writes SENT / APPROVED estimates, never mutates an
 * existing EstimateVersion snapshot, and never trusts a browser businessId.
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
import { laborMinimumAdjustment } from "@/lib/labor-minimum";
import { splitLineDescription } from "@/lib/estimate-line-scope";

const ZERO = new Prisma.Decimal(0);

export const MIN_ESTIMATE_OPTIONS = 2;
export const MAX_ESTIMATE_OPTIONS = 3;
export const MAX_OPTION_NAME_LENGTH = 80;

export const OPTIONS_OWNER_ONLY_MESSAGE =
  "Only the owner can prepare priced estimate options.";
export const DRAFT_ONLY_OPTIONS_MESSAGE =
  "Priced options can only be prepared on a draft estimate.";
export const OPTION_NAME_REQUIRED_MESSAGE = "Name this option before saving.";
export const OPTION_BOUND_MESSAGE = `An estimate can offer at most ${MAX_ESTIMATE_OPTIONS} priced options.`;
export const OPTION_MINIMUM_MESSAGE =
  "Add a second priced option, or remove options to send a single-scope estimate.";
export const OPTION_EMPTY_MESSAGE =
  "Each priced option needs at least one line before sending.";
export const OPTION_UNASSIGNED_LINE_MESSAGE =
  "Assign every line to one of the priced options before sending.";
export const OPTION_REQUIRED_MESSAGE =
  "Choose one priced option before approving this estimate.";
export const OPTION_STALE_MESSAGE =
  "This estimate was updated since you opened this page. Refresh to see the latest options before approving.";
export const OPTION_NOT_FOUND_MESSAGE =
  "That priced option is not on this draft estimate.";
export const OPTION_JOB_REQUIRED_MESSAGE =
  "This estimate needs a chosen option before it can become a job.";
export const OPTIONS_REMOVED_MESSAGE =
  "Priced options removed. This estimate is a single-scope draft again.";
export const OPTIONS_STARTED_MESSAGE =
  "Two priced options are ready. Price each one, then send so the customer can choose.";
export const OPTION_ADDED_MESSAGE = "Another priced option was added.";
export const OPTION_RENAMED_MESSAGE = "Option renamed.";
export const OPTION_REMOVED_MESSAGE = "That priced option was removed.";

export type EstimateOptionLine = {
  optionId?: string | null;
  type: string;
  total: Prisma.Decimal | { toString(): string } | number | string;
  description?: string;
};

export type PricedEstimateOption = {
  id: string;
  name: string;
  sortOrder: number;
};

export type OptionCommercials = {
  laborSubtotal: Prisma.Decimal;
  materialSubtotal: Prisma.Decimal;
  otherSubtotal: Prisma.Decimal;
  laborMinimumAdjustment: Prisma.Decimal;
  total: Prisma.Decimal;
  laborLineCount: number;
};

export type ChosenCommercialScope<TLine> = {
  total: Prisma.Decimal;
  laborMinimumAdjustment?: Prisma.Decimal;
  lineItems: TLine[];
  optionId: string | null;
  optionName: string | null;
};

export function canManageEstimateOptions(
  role: BusinessAccess["workspace"]["role"],
): boolean {
  return role === "OWNER" && canAccessManagementConsole(role);
}

export function assertCanManageEstimateOptions(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  requireBusinessRole(access, "OWNER");
}

export function parseOptionName(raw: string | null | undefined): {
  name: string | null;
  error: string | null;
} {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { name: null, error: OPTION_NAME_REQUIRED_MESSAGE };
  if (name.length > MAX_OPTION_NAME_LENGTH) {
    return {
      name: null,
      error: `Option name must be ${MAX_OPTION_NAME_LENGTH} characters or fewer.`,
    };
  }
  return { name, error: null };
}

export function defaultOptionName(sortOrder: number): string {
  return `Option ${sortOrder}`;
}

function toDecimal(value: Prisma.Decimal | { toString(): string } | number | string) {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value.toString());
}

function sumByType(items: EstimateOptionLine[], type: string) {
  return items
    .filter((item) => item.type === type)
    .reduce((sum, item) => sum.add(toDecimal(item.total)), ZERO);
}

function resolvedMaterialSubtotal(items: EstimateOptionLine[]) {
  for (const item of items) {
    const override = splitLineDescription(item.description ?? "").customerMaterialsTotal;
    if (override) {
      return new Prisma.Decimal(override.amount.toFixed(2));
    }
  }
  return sumByType(items, "MATERIAL");
}

export function computeOptionCommercials(
  items: EstimateOptionLine[],
  input: {
    enabled: boolean;
    amount: Prisma.Decimal | null;
    waived: boolean;
  },
): OptionCommercials {
  const laborSubtotal = sumByType(items, "LABOR");
  const materialSubtotal = resolvedMaterialSubtotal(items);
  const otherSubtotal = sumByType(items, "OTHER");
  const laborLineCount = items.filter((item) => item.type === "LABOR").length;
  const adjustment = laborMinimumAdjustment({
    laborSubtotal,
    laborLineCount,
    enabled: input.enabled,
    amount: input.amount,
    waived: input.waived,
  });
  return {
    laborSubtotal,
    materialSubtotal,
    otherSubtotal,
    laborMinimumAdjustment: adjustment,
    total: laborSubtotal.add(adjustment).add(materialSubtotal).add(otherSubtotal),
    laborLineCount,
  };
}

export function draftEstimateOptionsSendError(estimate: {
  lineItems: Array<{
    optionId?: string | null;
    description?: string;
  }>;
  options?: readonly PricedEstimateOption[] | null;
}): string | null {
  const options = estimate.options ?? [];
  if (options.length === 0) {
    if (estimate.lineItems.some((line) => line.optionId)) {
      return OPTION_UNASSIGNED_LINE_MESSAGE;
    }
    return null;
  }
  if (options.length < MIN_ESTIMATE_OPTIONS) {
    return OPTION_MINIMUM_MESSAGE;
  }
  if (options.length > MAX_ESTIMATE_OPTIONS) {
    return OPTION_BOUND_MESSAGE;
  }
  const optionIds = new Set(options.map((option) => option.id));
  if (estimate.lineItems.some((line) => !line.optionId || !optionIds.has(line.optionId))) {
    return OPTION_UNASSIGNED_LINE_MESSAGE;
  }
  for (const option of options) {
    const lines = estimate.lineItems.filter((line) => line.optionId === option.id);
    if (lines.length === 0) {
      return OPTION_EMPTY_MESSAGE;
    }
  }
  return null;
}

export function isMultiOptionEstimate(
  options: readonly unknown[] | null | undefined,
): boolean {
  return (options?.length ?? 0) >= MIN_ESTIMATE_OPTIONS;
}

export function resolveChosenCommercialScope<
  TLine extends { optionId?: string | null },
>(input: {
  total: Prisma.Decimal | { toString(): string } | number | string;
  laborMinimumAdjustment?: Prisma.Decimal | { toString(): string } | number | string;
  lineItems: TLine[];
  approvedOptionId?: string | null;
  approvedOption?: {
    id: string;
    name?: string | null;
    total: Prisma.Decimal | { toString(): string } | number | string;
    laborMinimumAdjustment?: Prisma.Decimal | { toString(): string } | number | string;
  } | null;
  approvedVersion?: {
    total: Prisma.Decimal | { toString(): string } | number | string;
    laborMinimumAdjustment?: Prisma.Decimal | { toString(): string } | number | string;
    lineItems?: TLine[];
    options?: Array<{
      id: string;
      name?: string | null;
      total: Prisma.Decimal | { toString(): string } | number | string;
      laborMinimumAdjustment?: Prisma.Decimal | { toString(): string } | number | string;
    }>;
  } | null;
}): ChosenCommercialScope<TLine> {
  const version = input.approvedVersion ?? null;
  const optionId = input.approvedOptionId ?? input.approvedOption?.id ?? null;
  const option =
    input.approvedOption ??
    version?.options?.find((row) => row.id === optionId) ??
    null;
  const versionLines = version?.lineItems ?? input.lineItems;
  if (optionId && option) {
    return {
      total: toDecimal(option.total),
      laborMinimumAdjustment: option.laborMinimumAdjustment
        ? toDecimal(option.laborMinimumAdjustment)
        : undefined,
      lineItems: versionLines.filter((line) => line.optionId === optionId),
      optionId,
      optionName: option.name ?? null,
    };
  }
  if (version) {
    return {
      total: toDecimal(version.total),
      laborMinimumAdjustment: version.laborMinimumAdjustment
        ? toDecimal(version.laborMinimumAdjustment)
        : undefined,
      lineItems: versionLines,
      optionId: null,
      optionName: null,
    };
  }
  return {
    total: toDecimal(input.total),
    laborMinimumAdjustment: input.laborMinimumAdjustment
      ? toDecimal(input.laborMinimumAdjustment)
      : undefined,
    lineItems: input.lineItems,
    optionId: null,
    optionName: null,
  };
}

export function isolateSameBusinessOptions<T extends { businessId: string }>(
  rows: T[],
  businessId: string,
): T[] {
  return rows.filter((row) => row.businessId === businessId);
}
