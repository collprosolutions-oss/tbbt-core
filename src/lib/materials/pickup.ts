/**
 * Material pickup requirements as data for scheduling (#105).
 * This module does not rewrite job calendar / availability architecture.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import type { FieldWorkspace } from "@/lib/field-access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { assertFieldPickupJob } from "@/lib/materials/access";
import { ensureMaterialsSuppliersTables } from "@/lib/materials/schema";
import {
  isPurchaseItemStatus,
  type FieldJobPickupView,
  type JobMaterialPickupRequirement,
} from "@/lib/materials/types";

export async function listJobMaterialPickupRequirements(
  db: PrismaClient,
  access: BusinessAccess,
  jobId: string,
): Promise<JobMaterialPickupRequirement[]> {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_JOBS);
  await ensureMaterialsSuppliersTables(db);
  access.assertOwned(
    await db.job.findFirst({
      where: { id: jobId, businessId: access.businessId },
      select: { id: true, businessId: true },
    }),
  );
  const items = await db.materialPurchaseListItem.findMany({
    where: {
      businessId: access.businessId,
      pickupRequired: true,
      status: { not: "CANCELLED" },
      purchaseList: { jobId },
    },
    include: { supplier: { select: { name: true, locationDescription: true } } },
    orderBy: { createdAt: "asc" },
  });
  return items.map((item) => ({
    jobId,
    purchaseListItemId: item.id,
    name: item.name,
    quantityNeeded: Number(item.quantityNeeded.toString()),
    unit: item.unit,
    supplierName: item.supplier?.name ?? null,
    locationDescription:
      item.pickupLocationDescription ?? item.supplier?.locationDescription ?? null,
    durationMinutes: item.pickupDurationMinutes,
    ready: item.pickupReady,
    status: isPurchaseItemStatus(item.status) ? item.status : "NEEDED",
  }));
}

export async function listAssignedJobPickupView(
  db: PrismaClient,
  field: FieldWorkspace,
  jobId: string,
): Promise<FieldJobPickupView[]> {
  await assertFieldPickupJob(db, field, jobId);
  const items = await db.materialPurchaseListItem.findMany({
    where: {
      businessId: field.businessId,
      pickupRequired: true,
      status: { not: "CANCELLED" },
      purchaseList: { jobId, businessId: field.businessId },
    },
    include: { supplier: { select: { name: true, locationDescription: true } } },
    orderBy: { createdAt: "asc" },
  });
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    quantityNeeded: item.quantityNeeded.toString(),
    unit: item.unit,
    supplierName: item.supplier?.name ?? null,
    pickupRequired: true,
    pickupLocationDescription:
      item.pickupLocationDescription ?? item.supplier?.locationDescription ?? null,
    pickupDurationMinutes: item.pickupDurationMinutes,
    pickupReady: item.pickupReady,
    status: isPurchaseItemStatus(item.status) ? item.status : "NEEDED",
  }));
}
