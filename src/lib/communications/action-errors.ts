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

function rethrowRedirect(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "digest" in error &&
    typeof (error as { digest?: string }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  ) {
    throw error;
  }
}

function saasSubscriptionRequiredMessage(error: unknown): string | null {
  if (error instanceof Error && error.name === "SaasSubscriptionRequiredError") {
    return error.message;
  }
  return null;
}

export function communicationsActionError(error: unknown): { error: string } {
  rethrowRedirect(error);
  if (isCommunicationsForbiddenError(error)) {
    return { error: COMMUNICATIONS_PERMISSION_ERROR };
  }
  const saasMessage = saasSubscriptionRequiredMessage(error);
  if (saasMessage) {
    return { error: saasMessage };
  }
  console.error(error);
  return { error: COMMUNICATIONS_UNEXPECTED_DISPOSITION_ERROR };
}
