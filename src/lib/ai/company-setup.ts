import { sanitizeAiText } from "@/lib/ai/sanitize";
import { AI_NOT_CONNECTED_MESSAGE, type StructuredAiOutput } from "@/lib/ai/types";
import {
  COMPANY_SETUP_FORBIDDEN_MESSAGE,
  COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE,
  type CompanySetupProposalDraftItem,
} from "@/lib/company-setup";

export function proposeCompanySetupFromDescription(input: {
  description: string;
  activeTradeCodes: string[];
}): { items: CompanySetupProposalDraftItem[]; summary: string; output: StructuredAiOutput } {
  const text = sanitizeAiText(input.description, 2_000);
  const sentences = text
    .split(/[.!\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 8);
  const serviceHints = sentences
    .flatMap((sentence) => sentence.split(/,| and | plus /i))
    .map((part) => part.trim())
    .filter((part) => /repair|install|clean|paint|fix|service|replace/i.test(part))
    .slice(0, 5);
  const items: CompanySetupProposalDraftItem[] = [];

  if (serviceHints.length) {
    for (const hint of serviceHints) {
      items.push({
        kind: "SERVICE",
        title: hint.slice(0, 80),
        body: `Suggested service from the owner's description. Created as a custom quote with no price.`,
        payload: { name: hint.slice(0, 80), description: hint },
      });
    }
  } else {
    items.push({
      kind: "SERVICE",
      title: "Core service to review",
      body: "Add the main service customers ask for. No price is stored until you set one.",
      payload: { name: "Primary service", description: text.slice(0, 160) },
    });
  }

  items.push({
    kind: "DESCRIPTION",
    title: "Business description",
    body: sentences[0] || text.slice(0, 280),
  });
  items.push({
    kind: "BRAND_VOICE",
    title: "Brand voice",
    body: /friendly|neighbor|local/i.test(text)
      ? "Friendly, local, and plain-spoken."
      : "Clear, professional, and practical.",
  });
  items.push({
    kind: "GOAL",
    title: "Get the company set up in TBBT",
    body: "Finish launch steps that still need an owner decision.",
  });
  items.push({
    kind: "PROCEDURE",
    title: "First-job checklist",
    body: "A reusable checklist for the first visits — not an automated workflow.",
    payload: {
      steps: [
        { title: "Confirm the requested work", body: "Repeat the customer's ask before starting." },
        { title: "Photograph existing conditions", body: "Keep photos on the job record." },
        { title: "Note extras before doing them", body: "Do not expand scope silently." },
      ],
    },
  });
  if (/clean/i.test(text) && !input.activeTradeCodes.includes("CLEANING")) {
    items.push({
      kind: "TRADE_ACTIVATION",
      title: "Cleaning trade",
      body: COMPANY_SETUP_FORBIDDEN_MESSAGE,
    });
  }

  const summary = `Proposed ${items.length} reviewable items from the owner's description. ${COMPANY_SETUP_PROPOSAL_ONLY_MESSAGE}`;
  return {
    items,
    summary,
    output: {
      text: summary,
      stance: "RECOMMENDATION",
      citedFactKeys: [],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
  };
}
