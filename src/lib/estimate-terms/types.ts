import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";

export const PROJECT_CONDITIONS_POLICY_ID = "project-conditions" as const;
export const PROJECT_CONDITIONS_TITLE =
  "PROJECT CONDITIONS / CUSTOMER RESPONSIBILITIES";
export const TERMS_AND_CONDITIONS_TITLE = "TERMS & CONDITIONS";

export type EstimateTermPack = "construction" | "cleaning";

export type EstimateTermTemplate = CalculatorCustomerPolicy & {
  packs: EstimateTermPack[] | "*";
  when?: {
    hasMaterials?: boolean;
    hasDeposit?: boolean;
  };
};

export type ComposeEstimateTermsInput = {
  existing?: CalculatorCustomerPolicy[] | null;
  titles?: Array<string | null | undefined>;
  takeoffType?: string | null;
  calculatorId?: string | null;
  intake?: unknown;
  hasMaterials?: boolean;
  hasDeposit?: boolean;
};
