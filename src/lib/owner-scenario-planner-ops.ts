/**
 * OWNER writes for named scenario-planner assumption sets.
 * businessId always comes from BusinessAccess. This module writes only
 * OwnerScenarioAssumptionSet rows — never invoices, payments, expenses,
 * jobs, catalog prices, or recorded facts.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import {
  CAPABILITIES,
  ForbiddenError,
  canAccessManagementConsole,
  requireBusinessCapability,
  requireBusinessRole,
} from "@/lib/authorization";
import {
  ASSUMPTION_SET_UNAVAILABLE_MESSAGE,
  FIX_ASSUMPTIONS_BEFORE_SAVE_MESSAGE,
  SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE,
  parseAssumptionSetName,
  parseOwnerScenarioAssumptions,
  toSavedOwnerScenarioAssumptionSet,
  type OwnerScenarioAssumptions,
  type SavedOwnerScenarioAssumptionSet,
} from "@/lib/owner-scenario-planner";

export class OwnerScenarioAssumptionSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerScenarioAssumptionSetError";
  }
}

export class OwnerScenarioAssumptionSetUnavailableError extends OwnerScenarioAssumptionSetError {
  constructor(message = ASSUMPTION_SET_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "OwnerScenarioAssumptionSetUnavailableError";
  }
}

export function missingAssumptionSetSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /OwnerScenarioAssumptionSet|ownerScenarioAssumptionSet|does not exist/i.test(message)
  );
}

export function ownerScenarioAssumptionSetErrorMessage(error: unknown, fallback: string) {
  if (
    error instanceof OwnerScenarioAssumptionSetError ||
    error instanceof OwnerScenarioAssumptionSetUnavailableError ||
    error instanceof ForbiddenError
  ) {
    return error.message;
  }
  if (missingAssumptionSetSchema(error)) {
    return ASSUMPTION_SET_UNAVAILABLE_MESSAGE;
  }
  if (error instanceof Error && /assumption set name|Name the assumption/i.test(error.message)) {
    return error.message;
  }
  return fallback;
}

export function assertCanWriteOwnerScenarioPlanner(access: BusinessAccess): void {
  if (!canAccessManagementConsole(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  requireBusinessRole(access, "OWNER");
}

export type SaveOwnerScenarioAssumptionSetInput = {
  name: string;
  workload?: string | null;
  materials?: string | null;
  labor?: string | null;
  price?: string | null;
  assumeUnpaid?: string | null;
};

function parseSaveInput(input: SaveOwnerScenarioAssumptionSetInput): {
  name: string;
  assumptions: OwnerScenarioAssumptions;
} {
  const named = parseAssumptionSetName(input.name);
  if (named.error || !named.name) {
    throw new OwnerScenarioAssumptionSetError(named.error ?? "Name the assumption set before saving.");
  }
  const assumptions = parseOwnerScenarioAssumptions(input);
  if (assumptions.errors.length > 0) {
    throw new OwnerScenarioAssumptionSetError(FIX_ASSUMPTIONS_BEFORE_SAVE_MESSAGE);
  }
  return { name: named.name, assumptions };
}

export async function saveOwnerScenarioAssumptionSet(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: SaveOwnerScenarioAssumptionSetInput,
): Promise<{ set: SavedOwnerScenarioAssumptionSet; created: boolean; message: string }> {
  assertCanWriteOwnerScenarioPlanner(access);
  const { name, assumptions } = parseSaveInput(input);
  const data = {
    name,
    workloadPercent: new Prisma.Decimal(assumptions.workloadPercent),
    materialCostPercent: new Prisma.Decimal(assumptions.materialCostPercent),
    laborCostPercent: new Prisma.Decimal(assumptions.laborCostPercent),
    pricePercent: new Prisma.Decimal(assumptions.pricePercent),
    assumeUnpaidInvoicesCollect: assumptions.assumeUnpaidInvoicesCollect,
  };

  try {
    const existing = await prisma.ownerScenarioAssumptionSet.findFirst({
      where: { businessId: access.businessId, name },
      select: { id: true, businessId: true },
    });
    if (existing && existing.businessId !== access.businessId) {
      throw new ForbiddenError();
    }

    const row = existing
      ? await prisma.ownerScenarioAssumptionSet.update({
          where: { id: existing.id },
          data,
        })
      : await prisma.ownerScenarioAssumptionSet.create({
          data: {
            ...data,
            businessId: access.businessId,
            createdByMembershipId: access.workspace.membership.id,
          },
        });

    if (row.businessId !== access.businessId) {
      throw new ForbiddenError();
    }

    return {
      set: toSavedOwnerScenarioAssumptionSet(row),
      created: !existing,
      message: SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE,
    };
  } catch (error) {
    if (missingAssumptionSetSchema(error)) {
      throw new OwnerScenarioAssumptionSetUnavailableError();
    }
    throw error;
  }
}
