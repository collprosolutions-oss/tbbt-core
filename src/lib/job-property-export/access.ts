import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { ForbiddenError, requireBusinessRole } from "@/lib/authorization";

export class JobPropertyExportError extends Error {
  readonly status: number;
  readonly code: "FORBIDDEN" | "NOT_FOUND" | "NOT_COMPLETED" | "NO_PROPERTY" | "INVALID";

  constructor(
    code: JobPropertyExportError["code"],
    message: string,
    status = code === "FORBIDDEN" ? 403 : code === "INVALID" ? 400 : 404,
  ) {
    super(message);
    this.name = "JobPropertyExportError";
    this.code = code;
    this.status = status;
  }
}

export function canExportCompletedJobProperty(role: MembershipRole): boolean {
  return role === "OWNER";
}

export function assertCanExportCompletedJobProperty(access: BusinessAccess): void {
  if (!canExportCompletedJobProperty(access.workspace.role)) {
    throw new ForbiddenError();
  }
  requireBusinessRole(access, "OWNER");
}

export function notFoundExportError(): JobPropertyExportError {
  return new JobPropertyExportError(
    "NOT_FOUND",
    "Completed job/property was not found in this workspace.",
  );
}

export function notCompletedExportError(): JobPropertyExportError {
  return new JobPropertyExportError(
    "NOT_COMPLETED",
    "Only a completed job can be exported.",
  );
}

export function noPropertyExportError(): JobPropertyExportError {
  return new JobPropertyExportError(
    "NO_PROPERTY",
    "This completed job has no same-business property to export.",
  );
}
