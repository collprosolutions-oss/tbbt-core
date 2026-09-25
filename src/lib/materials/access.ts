import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";
import type { FieldWorkspace } from "@/lib/field-access";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { requireProductCapability } from "@/lib/product-entitlements";
import { requireSaasOperatingEntitlement } from "@/lib/saas-billing/entitlement";
import { MaterialsError } from "@/lib/materials/errors";

type Db = PrismaClient | Prisma.TransactionClient;

export async function requireMaterialsCatalogAccess(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  await requireSaasOperatingEntitlement(db, access);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
}

export async function requireMaterialsEstimateAccess(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  await requireSaasOperatingEntitlement(db, access);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.ESTIMATES_INVOICES);
}

export async function requireMaterialsJobAccess(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await requireSaasOperatingEntitlement(db, access);
  await requireProductCapability(db, access.businessId, PRODUCT_CAPABILITIES.JOBS_TASKS);
}

export async function requireMaterialsExpenseAccess(db: Db, access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_EXPENSES);
  await requireSaasOperatingEntitlement(db, access);
}

export async function requirePurchaseListWriteAccess(
  db: Db,
  access: BusinessAccess,
  list: { jobId: string | null; estimateId: string | null },
) {
  if (list.jobId) {
    await requireMaterialsJobAccess(db, access);
    return;
  }
  await requireMaterialsEstimateAccess(db, access);
}

export async function assertFieldPickupJob(
  db: Db,
  field: FieldWorkspace,
  jobId: string,
) {
  const job = await db.job.findFirst({
    where: {
      id: jobId,
      businessId: field.businessId,
      assignedMembershipId: field.membershipId,
    },
    select: { id: true, businessId: true },
  });
  if (!job) {
    throw new ForbiddenError();
  }
  return job;
}

export function rejectMemberVendorEconomics(access: BusinessAccess) {
  if (access.workspace.role === "MEMBER") {
    throw new ForbiddenError();
  }
}

export function requireOwnedBusinessId(access: BusinessAccess, businessId: string) {
  if (access.businessId !== businessId) {
    throw new MaterialsError("Record is not in the authorized business workspace.");
  }
}
