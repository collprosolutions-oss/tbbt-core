import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";

export class CustomerRecordsExportError extends Error {
  readonly status: number;
  readonly code: "FORBIDDEN" | "NOT_FOUND" | "INVALID";

  constructor(
    code: CustomerRecordsExportError["code"],
    message: string,
    status = code === "FORBIDDEN" ? 403 : code === "INVALID" ? 400 : 404,
  ) {
    super(message);
    this.name = "CustomerRecordsExportError";
    this.code = code;
    this.status = status;
  }
}

export function canExportCustomerRecords(role: MembershipRole): boolean {
  return role === "OWNER";
}

export function assertCanExportCustomerRecords(access: BusinessAccess): void {
  if (!canExportCustomerRecords(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessRole(access, "OWNER");
}

export function notFoundCustomerRecordsExportError(): CustomerRecordsExportError {
  return new CustomerRecordsExportError(
    "NOT_FOUND",
    "Customer records were not found in this workspace.",
  );
}

export function invalidCustomerRecordsExportError(message: string): CustomerRecordsExportError {
  return new CustomerRecordsExportError("INVALID", message);
}
