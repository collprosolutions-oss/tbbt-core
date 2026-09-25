/**
 * Build My Company — AI proposal domain.
 *
 * AI output is a proposal. Consequential Core writes happen only after
 * the owner reviews and approves an item. Forbidden kinds are stored as
 * BLOCKED and never applied.
 */

export const COMPANY_SETUP_ITEM_KINDS = [
  "SERVICE",
  "DESCRIPTION",
  "BRAND_VOICE",
  "GOAL",
  "PROCEDURE",
  "SETUP_CHOICE",
  "TRADE_ACTIVATION",
  "SUBSCRIPTION",
  "WEBSITE_PUBLISH",
  "LEGAL",
  "PRICING",
] as const;
export type CompanySetupItemKind = (typeof COMPANY_SETUP_ITEM_KINDS)[number];

export const COMPANY_SETUP_ITEM_LABELS: Record<CompanySetupItemKind, string> = {
  SERVICE: "Service",
  DESCRIPTION: "Business description",
  BRAND_VOICE: "Brand voice",
  GOAL: "Business goal",
  PROCEDURE: "Procedure / checklist",
  SETUP_CHOICE: "Setup choice",
  TRADE_ACTIVATION: "Trade activation",
  SUBSCRIPTION: "Subscription change",
  WEBSITE_PUBLISH: "Website publish",
  LEGAL: "Legal commitment",
  PRICING: "Pricing change",
};

export const BLOCKED_COMPANY_SETUP_KINDS = [
  "TRADE_ACTIVATION",
  "SUBSCRIPTION",
  "WEBSITE_PUBLISH",
  "LEGAL",
] as const;

export function isCompanySetupItemKind(value: string | undefined): value is CompanySetupItemKind {
  return (COMPANY_SETUP_ITEM_KINDS as readonly string[]).includes(value ?? "");
}

export function isBlockedCompanySetupKind(kind: string) {
  return (BLOCKED_COMPANY_SETUP_KINDS as readonly string[]).includes(kind);
}

export const COMPANY_SETUP_ITEM_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "APPLIED",
  "BLOCKED",
] as const;
export type CompanySetupItemStatus = (typeof COMPANY_SETUP_ITEM_STATUSES)[number];

export const COMPANY_SETUP_PROPOSAL_STATUSES = [
  "DRAFT",
  "REVIEWED",
  "PARTIALLY_APPLIED",
  "APPLIED",
  "DISCARDED",
] as const;
export type CompanySetupProposalStatus = (typeof COMPANY_SETUP_PROPOSAL_STATUSES)[number];

export type CompanySetupProposalDraftItem = {
  kind: CompanySetupItemKind;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
};

export const COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE =
  "This is a proposal. TBBT will not write services, goals, brand voice, or procedures until you approve the item.";

export const COMPANY_SETUP_FORBIDDEN_MESSAGE =
  "TBBT will not enable a trade, change the subscription, publish the website, or create a legal commitment from an AI proposal.";
