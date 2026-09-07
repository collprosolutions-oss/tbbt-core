/**
 * Stamp composed customer terms onto a DRAFT estimate line before send
 * or owner save. SENT/APPROVED snapshots are never rewritten here.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import {
  isOriginalEstimateWorkLine,
  joinLineDescriptionFromParts,
  splitLineDescription,
} from "@/lib/estimate-line-scope";
import { resolveMaterialDeposit } from "@/lib/material-deposit";
import { normalizeCustomerPolicies } from "@/lib/estimate-policies";
import {
  collectEstimateTermContext,
  composeEstimateTerms,
} from "@/lib/estimate-terms/compose";
import { parseWorkAreaIntake } from "@/lib/work-area-intake";

type TermsClient = PrismaClient | Prisma.TransactionClient;

export async function stampDraftEstimateTerms(
  db: TermsClient,
  input: {
    estimateId: string;
    businessId: string;
    policies?: CalculatorCustomerPolicy[] | null;
    intake?: unknown;
  },
) {
  const estimate = await db.estimate.findFirst({
    where: { id: input.estimateId, businessId: input.businessId },
    include: {
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: { id: true, type: true, description: true, total: true },
      },
      serviceRequest: { select: { description: true } },
    },
  });
  if (!estimate || estimate.status !== "DRAFT" || estimate.lineItems.length === 0) {
    return;
  }

  const context = collectEstimateTermContext(estimate.lineItems);
  const deposit = resolveMaterialDeposit({
    lines: estimate.lineItems,
    total: estimate.total,
  });
  const intake =
    input.intake ?? parseWorkAreaIntake(estimate.serviceRequest?.description);
  const composed = composeEstimateTerms({
    existing:
      input.policies != null
        ? normalizeCustomerPolicies(input.policies)
        : context.existing,
    titles: context.titles,
    takeoffType: context.takeoffType,
    calculatorId: context.calculatorId,
    intake,
    hasMaterials: context.hasMaterials,
    hasDeposit: deposit.amount.gt(0),
  });

  const target =
    estimate.lineItems.find((line) => isOriginalEstimateWorkLine(line)) ??
    estimate.lineItems[0];
  if (!target) return;

  const targetParts = splitLineDescription(target.description);
  await db.lineItem.update({
    where: { id: target.id },
    data: {
      description: joinLineDescriptionFromParts(targetParts, {
        customerPolicies: composed,
      }),
    },
  });

  for (const line of estimate.lineItems) {
    if (line.id === target.id) continue;
    const parts = splitLineDescription(line.description);
    if (parts.customerPolicies.length === 0) continue;
    await db.lineItem.update({
      where: { id: line.id },
      data: {
        description: joinLineDescriptionFromParts(parts, {
          customerPolicies: [],
        }),
      },
    });
  }
}
