import type { ProductCapabilityCode, ProductLimitCode } from "@/lib/product-catalog/codes";

export class ProductCapabilityRequiredError extends Error {
  readonly capability: ProductCapabilityCode;

  constructor(
    capability: ProductCapabilityCode,
    message = "This TBBT plan does not include that feature. Existing records are retained.",
  ) {
    super(message);
    this.name = "ProductCapabilityRequiredError";
    this.capability = capability;
  }
}

export class ProductLimitExceededError extends Error {
  readonly limitCode: ProductLimitCode;

  constructor(
    limitCode: ProductLimitCode,
    message = "This TBBT plan does not allow that additional resource. Existing records are retained.",
  ) {
    super(message);
    this.name = "ProductLimitExceededError";
    this.limitCode = limitCode;
  }
}

export function productEntitlementErrorMessage(error: unknown): string | null {
  if (error instanceof ProductCapabilityRequiredError) return error.message;
  if (error instanceof ProductLimitExceededError) return error.message;
  if (error instanceof Error) {
    if (error.name === "ProductCapabilityRequiredError") return error.message;
    if (error.name === "ProductLimitExceededError") return error.message;
  }
  return null;
}
