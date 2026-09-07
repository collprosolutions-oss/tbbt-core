import type { EstimateTermPack, EstimateTermTemplate } from "@/lib/estimate-terms/types";

function term(
  partial: Omit<EstimateTermTemplate, "packs"> & { packs?: EstimateTermTemplate["packs"] },
): EstimateTermTemplate {
  return { packs: "*", ...partial };
}

export const CORE_AND_TRADE_TERM_TEMPLATES: readonly EstimateTermTemplate[] = [
  term({
    id: "core-scope-of-work",
    family: "core",
    title: "Scope of Work",
    body: "This estimate includes only the work specifically described in the estimate and Scope / Included Work. Additional work is not included unless approved in writing.",
  }),
  term({
    id: "core-changes-additional-work",
    family: "core",
    title: "Changes / Additional Work",
    body: "Customer-requested changes, additions, upgrades, extra trips, or work outside the written scope may change the price and/or schedule. Additional work should be approved before it is performed.",
  }),
  term({
    id: "core-unforeseen-conditions",
    family: "core",
    packs: ["construction"],
    title: "Unforeseen / Concealed Conditions",
    body: "Conditions that could not reasonably be identified before work begins — including concealed damage, rot, mold/moisture, hidden plumbing or electrical issues, structural problems, pest damage, code-related conditions, or hidden substrate problems — are outside this estimate unless specifically included. Additional work requires customer communication and may increase price or time.",
  }),
  term({
    id: "core-site-access",
    family: "core",
    title: "Site Access / Work Area",
    body: "Customer is responsible for providing reasonable access to the work area at agreed times and for satisfying the project-specific work-area conditions shown on this estimate, unless contractor-provided moving, protection, or cleanup is specifically included.",
  }),
  term({
    id: "core-belongings-protection",
    family: "core",
    title: "Belongings / Protection",
    body: "Normal protection included in the written scope is covered. Moving, protecting, storing, cleaning, or handling customer belongings beyond the included scope may be an additional charge.",
  }),
  term({
    id: "core-materials",
    family: "core",
    title: "Materials",
    when: { hasMaterials: true },
    body: "Material selections, quantities, availability, substitutions, special orders, price changes, and delivery conditions may affect final scope, schedule, or price where they apply to this job.",
  }),
  term({
    id: "core-material-deposit",
    family: "core",
    title: "Material Deposit",
    when: { hasDeposit: true },
    body: "When this estimate shows a material deposit, that amount is part of the estimate total, not an additional fee. It is due upon approval. The remaining balance is due as shown on this estimate.",
  }),
  term({
    id: "core-customer-supplied-materials",
    family: "core",
    optional: true,
    disabled: true,
    title: "Customer-Supplied Materials",
    body: "When the customer supplies materials, the business is not responsible for defects, shortages, incorrect sizing, missing components, compatibility problems, delays, or warranty issues caused by those materials. Additional labor or trips caused by those issues may be chargeable.",
  }),
  term({
    id: "core-permits",
    family: "core",
    optional: true,
    disabled: true,
    title: "Permits / Inspections",
    body: "Permits and inspections are included only when this estimate specifically says so. Unless listed, the customer is responsible for any required permits or inspections.",
  }),
  term({
    id: "core-schedule",
    family: "core",
    title: "Schedule / Delays",
    body: "Scheduling depends on approved scope, access, material availability, inspections, concealed conditions, and other circumstances outside reasonable business control. Weather may affect exterior work where applicable.",
  }),
  term({
    id: "core-payment",
    family: "core",
    title: "Payment",
    body: "Payment amounts and due dates are those shown on this estimate. Approval confirms the price and any deposit or remaining-balance requirements stated here.",
  }),
  term({
    id: "core-cleanup",
    family: "core",
    title: "Cleanup",
    body: "Ordinary job cleanup follows the written scope and project conditions. Deep cleaning, cleaning or moving customer belongings, or services outside normal trade cleanup are additional unless specifically included.",
  }),
  term({
    id: "core-acceptance",
    family: "core",
    title: "Acceptance",
    body: "Approval of this estimate confirms acceptance of the Scope / Included Work, price, any material deposit or payment requirements shown, Project Conditions / Customer Responsibilities, and these Terms & Conditions. This document is software-generated contract support and does not waive rights that cannot legally be waived.",
  }),
  term({
    id: "trade-construction",
    family: "trade",
    packs: ["construction"],
    title: "Construction / Renovation Conditions",
    body: "Demolition, substrate, and existing-condition discoveries may require extra work once surfaces are opened. Exterior work may also be affected by weather. Those items are not included unless specifically described.",
  }),
  term({
    id: "trade-cleaning-access",
    family: "trade",
    packs: ["cleaning"],
    title: "Cleaning Access & Utilities",
    body: "Customer is responsible for providing access, water, and electricity needed for the quoted cleaning. Pets should be secured as needed for safe work.",
  }),
  term({
    id: "trade-cleaning-belongings",
    family: "trade",
    packs: ["cleaning"],
    title: "Cleaning Belongings & Valuables",
    body: "Fragile, valuable, or sentimental items should be identified or removed before work. The quoted cleaning does not include handling valuables beyond the written scope.",
  }),
  term({
    id: "trade-cleaning-conditions",
    family: "trade",
    packs: ["cleaning"],
    title: "Cleaning Scope Limits",
    body: "Pre-existing damage, excessive soil, biohazard, or conditions beyond the quoted scope are not included unless specifically described. Additional work may change the price.",
  }),
];

export function termAppliesToPack(
  template: EstimateTermTemplate,
  pack: EstimateTermPack,
) {
  return template.packs === "*" || template.packs.includes(pack);
}
