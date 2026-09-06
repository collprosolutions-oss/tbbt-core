import type { LineItemType, Prisma } from "@prisma/client";

/**
 * Job/Work Order approved-scope resolution.
 *
 * A Job's "approved scope" is the exact set of line items and total price a
 * customer actually approved -- NOT whatever the linked Estimate's mutable
 * line items happen to say right now. Estimates can only be edited while
 * DRAFT (see src/app/actions/estimate.ts), and an approved Estimate is
 * never DRAFT again, so in practice its live fields do not drift after
 * approval -- but this module reads from the immutable EstimateVersion
 * explicitly (the same approach the public estimate page already takes;
 * see src/app/e/[token]/page.tsx) so a Job stays correct even if that
 * invariant is ever loosened, and so the exact approved version number is
 * always available to show.
 *
 * Do not add a code path here that mutates an EstimateVersion or its line
 * items -- this module only ever reads.
 */

export type WorkOrderLineItem = {
  description: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  total: Prisma.Decimal;
  type: LineItemType;
};

export type ApprovedWorkOrderScope =
  | {
      /** Bound to the exact immutable EstimateVersion the customer approved. */
      source: "version";
      versionNumber: number;
      total: Prisma.Decimal;
      laborMinimumAdjustment: Prisma.Decimal;
      approvedAt: Date | null;
      lineItems: WorkOrderLineItem[];
    }
  | {
      /**
       * No EstimateVersion is bound to this Job (a legacy Job created
       * before this relation existed, or created from an Estimate that had
       * no approved version on record). Falls back to the live linked
       * Estimate's current line items/total for display only -- this is a
       * safe fallback, not a fabricated approval record.
       */
      source: "legacy-estimate";
      total: Prisma.Decimal;
      lineItems: WorkOrderLineItem[];
    }
  | {
      /** No linked Estimate or EstimateVersion at all. */
      source: "none";
    };

type JobForScopeResolution = {
  approvedEstimateVersion: {
    versionNumber: number;
    total: Prisma.Decimal;
    laborMinimumAdjustment: Prisma.Decimal;
    approvedAt: Date | null;
    lineItems: WorkOrderLineItem[];
  } | null;
  estimate: {
    total: Prisma.Decimal;
    lineItems: WorkOrderLineItem[];
  } | null;
};

/**
 * Resolves the scope a Job/Work Order should display as "approved", per the
 * priority: bound EstimateVersion first, then a live-Estimate fallback for
 * legacy Jobs, then nothing. Pure function -- callers are responsible for
 * fetching `job` with exactly the shape above (see the Prisma `include`
 * clauses in src/app/(app)/jobs/[jobId]/page.tsx and
 * src/app/p/[token]/page.tsx).
 */
export function resolveApprovedWorkOrderScope(
  job: JobForScopeResolution,
): ApprovedWorkOrderScope {
  if (job.approvedEstimateVersion) {
    const version = job.approvedEstimateVersion;
    return {
      source: "version",
      versionNumber: version.versionNumber,
      total: version.total,
      laborMinimumAdjustment: version.laborMinimumAdjustment,
      approvedAt: version.approvedAt,
      lineItems: version.lineItems,
    };
  }

  if (job.estimate) {
    return {
      source: "legacy-estimate",
      total: job.estimate.total,
      lineItems: job.estimate.lineItems,
    };
  }

  return { source: "none" };
}
