"use server";

import { revalidatePath } from "next/cache";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  addPurchaseListItem,
  convertTakeoffToPurchaseList,
  createMaterialCatalogItem,
  createPurchaseOrder,
  createSupplier,
  linkPurchaseItemToExpense,
  materialsErrorMessage,
  recordPurchaseListItemPurchased,
  updateMaterialCatalogItem,
  updatePurchaseListItem,
  updatePurchaseOrderStatus,
  updateSupplier,
} from "@/lib/materials";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { prisma } from "@/lib/prisma";
import { requireOperatingProductAccessForForm } from "@/lib/saas-billing/enforce";

export type MaterialsActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readChecked(formData: FormData, key: string) {
  return readString(formData, key) === "1" || readString(formData, key) === "on";
}

function revalidateMaterials(paths: string[]) {
  revalidatePath("/materials");
  for (const path of paths) revalidatePath(path);
}

export async function createSupplierAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const operating = await requireOperatingProductAccessForForm(
      PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_ESTIMATES);
    await createSupplier(prisma, operating.access, {
      name: readString(formData, "name"),
      contactName: readString(formData, "contactName"),
      contactEmail: readString(formData, "contactEmail"),
      contactPhone: readString(formData, "contactPhone"),
      website: readString(formData, "website"),
      accountReference: readString(formData, "accountReference"),
      preferred: readChecked(formData, "preferred"),
      notes: readString(formData, "notes"),
      categories: readString(formData, "categories"),
      locationDescription: readString(formData, "locationDescription"),
    });
    revalidateMaterials([]);
    return { message: "Supplier saved." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That supplier could not be saved.") };
  }
}

export async function updateSupplierAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const operating = await requireOperatingProductAccessForForm(
      PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_ESTIMATES);
    await updateSupplier(prisma, operating.access, {
      supplierId: readString(formData, "supplierId"),
      name: readString(formData, "name"),
      contactName: readString(formData, "contactName"),
      contactEmail: readString(formData, "contactEmail"),
      contactPhone: readString(formData, "contactPhone"),
      website: readString(formData, "website"),
      accountReference: readString(formData, "accountReference"),
      preferred: readChecked(formData, "preferred"),
      notes: readString(formData, "notes"),
      categories: readString(formData, "categories"),
      locationDescription: readString(formData, "locationDescription"),
      active: !readChecked(formData, "inactive"),
    });
    revalidateMaterials([]);
    return { message: "Supplier updated." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That supplier could not be updated.") };
  }
}

export async function createCatalogItemAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const operating = await requireOperatingProductAccessForForm(
      PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_ESTIMATES);
    await createMaterialCatalogItem(prisma, operating.access, {
      name: readString(formData, "name"),
      sku: readString(formData, "sku"),
      unit: readString(formData, "unit") || "ea",
      packSize: readString(formData, "packSize"),
      preferredSupplierId: readString(formData, "preferredSupplierId") || null,
      lastKnownCost: readString(formData, "lastKnownCost"),
      notes: readString(formData, "notes"),
      category: readString(formData, "category"),
      takeoffIdentity: readString(formData, "takeoffIdentity"),
    });
    revalidateMaterials([]);
    return { message: "Material saved." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That material could not be saved.") };
  }
}

export async function updateCatalogItemAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const operating = await requireOperatingProductAccessForForm(
      PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_ESTIMATES);
    await updateMaterialCatalogItem(prisma, operating.access, {
      materialId: readString(formData, "materialId"),
      name: readString(formData, "name"),
      sku: readString(formData, "sku"),
      unit: readString(formData, "unit") || "ea",
      packSize: readString(formData, "packSize"),
      preferredSupplierId: readString(formData, "preferredSupplierId") || null,
      lastKnownCost: readString(formData, "lastKnownCost"),
      notes: readString(formData, "notes"),
      category: readString(formData, "category"),
      takeoffIdentity: readString(formData, "takeoffIdentity"),
      active: !readChecked(formData, "inactive"),
    });
    revalidateMaterials([]);
    return { message: "Material updated. Earlier price-history rows were kept." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That material could not be updated.") };
  }
}

export async function convertTakeoffToPurchaseListAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const operating = await requireOperatingProductAccessForForm(
      PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(operating.access, CAPABILITIES.MANAGE_ESTIMATES);
    const estimateId = readString(formData, "estimateId");
    const result = await convertTakeoffToPurchaseList(prisma, operating.access, {
      estimateId,
      linkCatalog: true,
    });
    revalidateMaterials([`/estimates/${estimateId}`]);
    return {
      message: `Purchase list updated (${result.created} added). TBBT did not place an order.`,
    };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That takeoff could not become a purchase list.") };
  }
}

export async function addPurchaseListItemAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const jobId = readString(formData, "jobId");
    const estimateId = readString(formData, "estimateId");
    const operating = await requireOperatingProductAccessForForm(
      jobId ? PRODUCT_CAPABILITIES.JOBS_TASKS : PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(
      operating.access,
      jobId ? CAPABILITIES.MANAGE_JOBS : CAPABILITIES.MANAGE_ESTIMATES,
    );
    await addPurchaseListItem(prisma, operating.access, {
      purchaseListId: readString(formData, "purchaseListId"),
      materialId: readString(formData, "materialId") || null,
      supplierId: readString(formData, "supplierId") || null,
      name: readString(formData, "name"),
      quantityNeeded: readString(formData, "quantityNeeded"),
      unit: readString(formData, "unit") || "ea",
      plannedUnitCost: readString(formData, "plannedUnitCost"),
      pickupRequired: readChecked(formData, "pickupRequired"),
      pickupLocationDescription: readString(formData, "pickupLocationDescription"),
      pickupDurationMinutes: readString(formData, "pickupDurationMinutes"),
    });
    revalidateMaterials([
      jobId ? `/jobs/${jobId}` : "",
      estimateId ? `/estimates/${estimateId}` : "",
    ].filter(Boolean));
    return { message: "Purchase-list item added. No supplier order was placed." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That purchase-list item could not be added.") };
  }
}

export async function updatePurchaseListItemAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const jobId = readString(formData, "jobId");
    const estimateId = readString(formData, "estimateId");
    const operating = await requireOperatingProductAccessForForm(
      jobId ? PRODUCT_CAPABILITIES.JOBS_TASKS : PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    requireBusinessCapability(
      operating.access,
      jobId ? CAPABILITIES.MANAGE_JOBS : CAPABILITIES.MANAGE_ESTIMATES,
    );
    await updatePurchaseListItem(prisma, operating.access, {
      itemId: readString(formData, "itemId"),
      purchaseListId: readString(formData, "purchaseListId"),
      materialId: readString(formData, "materialId") || null,
      supplierId: readString(formData, "supplierId") || null,
      name: readString(formData, "name"),
      quantityNeeded: readString(formData, "quantityNeeded"),
      unit: readString(formData, "unit") || "ea",
      plannedUnitCost: readString(formData, "plannedUnitCost"),
      quantityPurchased: readString(formData, "quantityPurchased"),
      actualUnitCost: readString(formData, "actualUnitCost"),
      pickupRequired: readChecked(formData, "pickupRequired"),
      pickupLocationDescription: readString(formData, "pickupLocationDescription"),
      pickupDurationMinutes: readString(formData, "pickupDurationMinutes"),
      pickupReady: readChecked(formData, "pickupReady"),
      status: readString(formData, "status") || "NEEDED",
      notes: readString(formData, "notes"),
      markupPercent: readString(formData, "markupPercent"),
      customerUnitPrice: readString(formData, "customerUnitPrice"),
    });
    revalidateMaterials([
      jobId ? `/jobs/${jobId}` : "",
      estimateId ? `/estimates/${estimateId}` : "",
    ].filter(Boolean));
    return { message: "Purchase-list item updated." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That purchase-list item could not be updated.") };
  }
}

export async function recordPurchaseAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const jobId = readString(formData, "jobId");
    const operating = await requireOperatingProductAccessForForm(
      jobId ? PRODUCT_CAPABILITIES.JOBS_TASKS : PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    await recordPurchaseListItemPurchased(prisma, operating.access, {
      itemId: readString(formData, "itemId"),
      quantityPurchased: readString(formData, "quantityPurchased"),
      actualUnitCost: readString(formData, "actualUnitCost"),
      supplierId: readString(formData, "supplierId") || null,
    });
    if (readChecked(formData, "createExpense")) {
      const expenseAccess = await requireOperatingProductAccessForForm(
        PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
      );
      if (!expenseAccess.ok) return { error: expenseAccess.error };
      requireBusinessCapability(expenseAccess.access, CAPABILITIES.MANAGE_EXPENSES);
      await linkPurchaseItemToExpense(prisma, expenseAccess.access, {
        itemId: readString(formData, "itemId"),
        createExpense: true,
        occurredOn: readString(formData, "occurredOn"),
        quantityPurchased: readString(formData, "quantityPurchased"),
        actualUnitCost: readString(formData, "actualUnitCost"),
      });
    }
    revalidateMaterials([
      jobId ? `/jobs/${jobId}` : "",
      readString(formData, "estimateId") ? `/estimates/${readString(formData, "estimateId")}` : "",
      "/expenses",
    ].filter(Boolean));
    return { message: "Purchase recorded. Customer invoice was not changed." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That purchase could not be recorded.") };
  }
}

export async function createPurchaseOrderAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const jobId = readString(formData, "jobId");
    const operating = await requireOperatingProductAccessForForm(
      jobId ? PRODUCT_CAPABILITIES.JOBS_TASKS : PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    await createPurchaseOrder(prisma, operating.access, {
      purchaseListId: readString(formData, "purchaseListId"),
      supplierId: readString(formData, "supplierId") || null,
      notes: readString(formData, "notes"),
    });
    revalidateMaterials([jobId ? `/jobs/${jobId}` : ""].filter(Boolean));
    return { message: "Draft purchase order created for tracking. No supplier was contacted." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That purchase order could not be created.") };
  }
}

export async function updatePurchaseOrderStatusAction(
  _prev: MaterialsActionState,
  formData: FormData,
): Promise<MaterialsActionState> {
  try {
    const jobId = readString(formData, "jobId");
    const operating = await requireOperatingProductAccessForForm(
      jobId ? PRODUCT_CAPABILITIES.JOBS_TASKS : PRODUCT_CAPABILITIES.ESTIMATES_INVOICES,
    );
    if (!operating.ok) return { error: operating.error };
    await updatePurchaseOrderStatus(prisma, operating.access, {
      purchaseOrderId: readString(formData, "purchaseOrderId"),
      status: readString(formData, "status"),
    });
    revalidateMaterials([jobId ? `/jobs/${jobId}` : ""].filter(Boolean));
    return { message: "Purchase-order status updated. This is owner tracking only." };
  } catch (error) {
    return { error: materialsErrorMessage(error, "That purchase order could not be updated.") };
  }
}
