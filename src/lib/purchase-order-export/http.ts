/**
 * Route-level OWNER download for one recorded purchase-order supplier handoff.
 *
 * Browser business IDs never authorize it. The download is a read of
 * tenant-owned records and never places an order, calls a supplier API,
 * scrapes prices, records a receipt, or sends a customer message.
 */
import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import {
  PurchaseOrderExportError,
  canExportPurchaseOrderSupplierHandoff,
} from "@/lib/purchase-order-export/access";
import {
  buildPurchaseOrderSupplierHandoff,
  purchaseOrderSupplierHandoffCsv,
} from "@/lib/purchase-order-export/build";
import { purchaseOrderSupplierHandoffFilename } from "@/lib/purchase-order-export/contract";

export type PurchaseOrderExportDownloadResult =
  | {
      ok: true;
      status: 200;
      filename: string;
      contentType: "text/csv; charset=utf-8";
      body: string;
    }
  | {
      ok: false;
      status: 400 | 403 | 404;
      error: string;
    };

export async function runPurchaseOrderSupplierHandoffDownload(
  prisma: PrismaClient,
  access: BusinessAccess,
  input: { purchaseOrderId: string },
): Promise<PurchaseOrderExportDownloadResult> {
  if (!canExportPurchaseOrderSupplierHandoff(access.workspace.role)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }

  try {
    const document = await buildPurchaseOrderSupplierHandoff(prisma, access, input);
    return {
      ok: true,
      status: 200,
      filename: purchaseOrderSupplierHandoffFilename(document),
      contentType: "text/csv; charset=utf-8",
      body: purchaseOrderSupplierHandoffCsv(document),
    };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    if (error instanceof PurchaseOrderExportError) {
      return { ok: false, status: error.status as 400 | 403 | 404, error: error.message };
    }
    throw error;
  }
}
