import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";

export class PurchaseOrderExportError extends Error {
  readonly status: number;
  readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID";

  constructor(
    code: PurchaseOrderExportError["code"],
    message: string,
    status = code === "FORBIDDEN" ? 403 : code === "INVALID" ? 400 : 404,
  ) {
    super(message);
    this.name = "PurchaseOrderExportError";
    this.code = code;
    this.status = status;
  }
}

export function canExportPurchaseOrderSupplierHandoff(role: MembershipRole): boolean {
  return role === "OWNER";
}

export function assertCanExportPurchaseOrderSupplierHandoff(access: BusinessAccess): void {
  if (!canExportPurchaseOrderSupplierHandoff(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessRole(access, "OWNER");
}

export function notFoundPurchaseOrderExportError(): PurchaseOrderExportError {
  return new PurchaseOrderExportError(
    "NOT_FOUND",
    "That purchase order was not found in this workspace.",
  );
}

export function invalidPurchaseOrderExportError(message: string): PurchaseOrderExportError {
  return new PurchaseOrderExportError("INVALID", message);
}
