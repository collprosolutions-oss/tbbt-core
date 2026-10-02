import { ForbiddenError } from "@/lib/authorization";

export const COMMUNICATIONS_PERMISSION_ERROR = "You do not have permission to do that.";
export const COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR =
  "Something went wrong while recording that disposition.";

export function isCommunicationsForbiddenError(error: unknown) {
  return (
    error instanceof ForbiddenError ||
    (error instanceof Error && error.name === "ForbiddenError")
  );
}

export function communicationsActionError(error: unknown): { error: string } {
  if (isCommunicationsForbiddenError(error)) {
    return { error: COMMUNICATIONS_PERMISSION_ERROR };
  }
  return { error: COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR };
}
