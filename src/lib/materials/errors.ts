export class MaterialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterialsError";
  }
}

export function materialsErrorMessage(error: unknown, fallback: string) {
  if (error instanceof MaterialsError) return error.message;
  if (error instanceof Error && error.name === "ForbiddenError") return error.message;
  if (error instanceof Error && error.name === "SaasSubscriptionRequiredError") {
    return error.message;
  }
  if (error instanceof Error && error.name === "ProductEntitlementError") {
    return error.message;
  }
  return fallback;
}
