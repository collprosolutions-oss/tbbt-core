/**
 * Downgrade / removed-capability rules.
 *
 * A plan change must never delete historical business records.
 */
export const PRODUCT_DOWNGRADE_RULES = {
  preserveRecords: true,
  preserveExport: true,
  preserveBilling: true,
  preserveOffboarding: true,
  preserveAccountAccess: true,
  blockCreateAndMaterialMutation: true,
  allowReadOnlyHistoricalVisibility: true,
  publicSurfacesFailSafe: true,
  doNotHoldDataHostage: true,
} as const;

export const PRODUCT_DOWNGRADE_POLICY = [
  "Existing records remain after a downgrade or capability removal.",
  "Data export and offboarding remain available even when operating entitlement is blocked.",
  "Billing and account/security access remain.",
  "Creation and material mutation of no-longer-entitled premium features is blocked.",
  "Read-only historical visibility may remain where it is safe.",
  "Public customer intake and published website reads stay available unless an existing SaaS policy already blocks them.",
  "Downgrade never deletes files, memberships, trades, or jobs. Over-limit states block new additions until usage is back within the entitled allowance or an add-on increases it.",
  "Founder eligibility, conversion, and eligibility-ended timestamps are historical facts and are not rewritten by a later plan change.",
].join(" ");
