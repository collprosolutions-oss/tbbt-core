/**
 * Agreement Coach lifecycle, generic draft templates, and risk review.
 *
 * Drafts are organization assistance. They are not legal advice and do
 * not invent state-specific clauses.
 */

import {
  AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
  AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE,
  NO_STATE_CLAUSE_MESSAGE,
} from "@/lib/business-protection";

export const AGREEMENT_TYPES = [
  "CUSTOMER_AGREEMENT",
  "SUBCONTRACTOR_AGREEMENT",
  "INDEPENDENT_CONTRACTOR_AGREEMENT",
  "NDA",
  "REFERRAL_AGREEMENT",
  "PARTNERSHIP_AGREEMENT",
  "VENDOR_AGREEMENT",
  "CUSTOM_AGREEMENT",
] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

export const AGREEMENT_TYPE_LABELS: Record<AgreementType, string> = {
  CUSTOMER_AGREEMENT: "Customer agreement",
  SUBCONTRACTOR_AGREEMENT: "Subcontractor agreement",
  INDEPENDENT_CONTRACTOR_AGREEMENT: "Independent contractor agreement",
  NDA: "NDA",
  REFERRAL_AGREEMENT: "Referral agreement",
  PARTNERSHIP_AGREEMENT: "Partnership / collaboration agreement",
  VENDOR_AGREEMENT: "Vendor agreement",
  CUSTOM_AGREEMENT: "Custom agreement",
};

export const AGREEMENT_LIFECYCLE_STATUSES = [
  "QUESTIONS",
  "DRAFT",
  "RISK_REVIEW",
  "OWNER_REVIEW",
  "LEGAL_WARNING",
  "READY",
  "SENT",
  "SIGNED",
  "COMPLETE",
  "EXTERNAL_COMPLETE",
] as const;
export type AgreementLifecycleStatus = (typeof AGREEMENT_LIFECYCLE_STATUSES)[number];

export const AGREEMENT_LIFECYCLE_LABELS: Record<AgreementLifecycleStatus, string> = {
  QUESTIONS: "Guided questions",
  DRAFT: "Draft content",
  RISK_REVIEW: "Risk / missing-term review",
  OWNER_REVIEW: "Owner review",
  LEGAL_WARNING: "Legal-review warning",
  READY: "Ready",
  SENT: "Sent",
  SIGNED: "Signed",
  COMPLETE: "Complete",
  EXTERNAL_COMPLETE: "Completed externally",
};

export const AGREEMENT_VERSION_STATUSES = ["DRAFT", "SENT", "SIGNED_FINAL", "SUPERSEDED"] as const;
export type AgreementVersionStatus = (typeof AGREEMENT_VERSION_STATUSES)[number];

export const HIGH_RISK_AGREEMENT_TYPES = new Set<AgreementType>([
  "CUSTOMER_AGREEMENT",
  "SUBCONTRACTOR_AGREEMENT",
  "INDEPENDENT_CONTRACTOR_AGREEMENT",
  "PARTNERSHIP_AGREEMENT",
  "CUSTOM_AGREEMENT",
]);

export const COMPLETED_AGREEMENT_STATUSES = new Set<AgreementLifecycleStatus>([
  "SIGNED",
  "COMPLETE",
  "EXTERNAL_COMPLETE",
]);

export const LOCKED_VERSION_STATUSES = new Set<AgreementVersionStatus>([
  "SENT",
  "SIGNED_FINAL",
]);

export type AgreementQuestion = {
  id: string;
  label: string;
  required: boolean;
  kind?: "text" | "date" | "textarea";
  topic: string;
};

const SHARED_QUESTIONS: AgreementQuestion[] = [
  { id: "counterparty", label: "Other party name", required: true, topic: "parties" },
  { id: "purpose", label: "What this agreement is for", required: true, kind: "textarea", topic: "purpose" },
  { id: "effectiveOn", label: "Effective date", required: false, kind: "date", topic: "dates" },
  { id: "expiresOn", label: "End or renewal date", required: false, kind: "date", topic: "dates" },
  {
    id: "ownerGoverningNote",
    label: "Governing-law or local note supplied by you (optional — do not invent a state)",
    required: false,
    kind: "textarea",
    topic: "governing_law",
  },
];

export const AGREEMENT_QUESTION_SETS: Record<AgreementType, AgreementQuestion[]> = {
  CUSTOMER_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "scope", label: "Work or services covered", required: true, kind: "textarea", topic: "scope" },
    { id: "payment", label: "Price or payment terms you want recorded", required: true, kind: "textarea", topic: "payment" },
    { id: "extraWork", label: "How extra / change work is handled", required: false, kind: "textarea", topic: "changes" },
    { id: "warranty", label: "Warranty or workmanship terms, if any", required: false, kind: "textarea", topic: "warranty" },
  ],
  SUBCONTRACTOR_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "scope", label: "Subcontractor scope", required: true, kind: "textarea", topic: "scope" },
    { id: "payment", label: "Pay terms you want recorded", required: true, kind: "textarea", topic: "payment" },
    { id: "insurance", label: "Insurance the subcontractor should carry (owner-stated)", required: false, kind: "textarea", topic: "insurance" },
    { id: "safety", label: "Safety or site rules you want recorded", required: false, kind: "textarea", topic: "safety" },
  ],
  INDEPENDENT_CONTRACTOR_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "scope", label: "Services the contractor will provide", required: true, kind: "textarea", topic: "scope" },
    { id: "payment", label: "Fee / invoice terms", required: true, kind: "textarea", topic: "payment" },
    { id: "independence", label: "How independence / non-employment is described (owner-stated)", required: false, kind: "textarea", topic: "status" },
  ],
  NDA: [
    ...SHARED_QUESTIONS,
    { id: "confidential", label: "What information should stay confidential", required: true, kind: "textarea", topic: "confidentiality" },
    { id: "duration", label: "How long confidentiality should last (owner-stated)", required: false, topic: "duration" },
  ],
  REFERRAL_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "referrals", label: "What referrals are covered", required: true, kind: "textarea", topic: "scope" },
    { id: "compensation", label: "Referral fee or other compensation (owner-stated)", required: true, kind: "textarea", topic: "payment" },
  ],
  PARTNERSHIP_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "roles", label: "Each party's role", required: true, kind: "textarea", topic: "roles" },
    { id: "money", label: "Money, split, or contribution terms (owner-stated)", required: true, kind: "textarea", topic: "payment" },
    { id: "exit", label: "How the arrangement can end (owner-stated)", required: false, kind: "textarea", topic: "termination" },
  ],
  VENDOR_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "goods", label: "Goods or services the vendor supplies", required: true, kind: "textarea", topic: "scope" },
    { id: "payment", label: "Vendor payment terms", required: true, kind: "textarea", topic: "payment" },
    { id: "delivery", label: "Delivery or timing expectations", required: false, kind: "textarea", topic: "delivery" },
  ],
  CUSTOM_AGREEMENT: [
    ...SHARED_QUESTIONS,
    { id: "terms", label: "Terms you want drafted from your notes", required: true, kind: "textarea", topic: "terms" },
  ],
};

export type RiskFinding = {
  topic: string;
  severity: "missing" | "high_risk" | "notice";
  message: string;
};

export function isAgreementType(value: string): value is AgreementType {
  return (AGREEMENT_TYPES as readonly string[]).includes(value);
}

export function isAgreementLifecycleStatus(value: string): value is AgreementLifecycleStatus {
  return (AGREEMENT_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

export function isAgreementVersionStatus(value: string): value is AgreementVersionStatus {
  return (AGREEMENT_VERSION_STATUSES as readonly string[]).includes(value);
}

export function isHighRiskAgreement(type: AgreementType): boolean {
  return HIGH_RISK_AGREEMENT_TYPES.has(type);
}

export function isCompletedAgreement(status: AgreementLifecycleStatus): boolean {
  return COMPLETED_AGREEMENT_STATUSES.has(status);
}

export function isLockedVersion(status: AgreementVersionStatus, lockedAt?: Date | null): boolean {
  return LOCKED_VERSION_STATUSES.has(status) || Boolean(lockedAt);
}

export function parseAgreementAnswers(raw: string | null | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function requiredQuestionsMissing(
  type: AgreementType,
  answers: Record<string, string>,
): AgreementQuestion[] {
  return AGREEMENT_QUESTION_SETS[type].filter(
    (question) => question.required && !answers[question.id]?.trim(),
  );
}

export function buildAgreementDraft(input: {
  type: AgreementType;
  title: string;
  businessName: string;
  answers: Record<string, string>;
}): string {
  const label = AGREEMENT_TYPE_LABELS[input.type];
  const counterparty = input.answers.counterparty?.trim() || "[Other party — owner to complete]";
  const purpose = input.answers.purpose?.trim() || input.answers.scope?.trim() || input.answers.terms?.trim() || "[Purpose — owner to complete]";
  const effective = input.answers.effectiveOn?.trim() || "[Effective date — owner to complete]";
  const expires = input.answers.expiresOn?.trim() || "[End / renewal date — owner to complete if needed]";
  const governing = input.answers.ownerGoverningNote?.trim();
  const extraBlocks = AGREEMENT_QUESTION_SETS[input.type]
    .filter((question) => !["counterparty", "purpose", "effectiveOn", "expiresOn", "ownerGoverningNote"].includes(question.id))
    .map((question) => {
      const value = input.answers[question.id]?.trim();
      return `${question.label}\n${value || `[${question.label} — owner to complete]`}`;
    });

  return [
    input.title.trim() || label,
    "",
    `This is an owner-assisted ${label.toLowerCase()} draft for ${input.businessName} and ${counterparty}.`,
    "",
    AGREEMENT_NOT_LEGAL_ADVICE_MESSAGE,
    AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
    NO_STATE_CLAUSE_MESSAGE,
    "",
    `Purpose\n${purpose}`,
    "",
    `Effective date: ${effective}`,
    `End or renewal date: ${expires}`,
    "",
    ...extraBlocks.flatMap((block) => [block, ""]),
    governing
      ? `Owner-supplied governing-law / local note\n${governing}`
      : "Governing law: not supplied. TBBT did not insert a state or jurisdiction.",
    "",
    "Signature block (external / manual — no digital signature is applied here)",
    `${input.businessName}: ________________________  Date: __________`,
    `${counterparty}: ________________________  Date: __________`,
  ].join("\n");
}

export function reviewAgreementRisk(input: {
  type: AgreementType;
  answers: Record<string, string>;
  draftContent: string;
}): { findings: RiskFinding[]; attorneyRecommended: boolean } {
  const findings: RiskFinding[] = [];
  for (const missing of requiredQuestionsMissing(input.type, input.answers)) {
    findings.push({
      topic: missing.topic,
      severity: "missing",
      message: `Missing: ${missing.label}.`,
    });
  }
  if (!input.answers.expiresOn?.trim() && !input.answers.duration?.trim()) {
    findings.push({
      topic: "dates",
      severity: "notice",
      message: "No end or renewal date is recorded. Add one if this arrangement should expire.",
    });
  }
  if (!input.answers.ownerGoverningNote?.trim()) {
    findings.push({
      topic: "governing_law",
      severity: "notice",
      message: NO_STATE_CLAUSE_MESSAGE,
    });
  }
  const draft = input.draftContent.trim();
  if (!draft) {
    findings.push({
      topic: "draft",
      severity: "missing",
      message: "No draft content yet.",
    });
  }
  const attorneyRecommended = isHighRiskAgreement(input.type) || findings.some((row) => row.severity === "missing");
  if (attorneyRecommended) {
    findings.push({
      topic: "attorney",
      severity: "high_risk",
      message: AGREEMENT_ATTORNEY_RECOMMENDATION_MESSAGE,
    });
  }
  findings.push({
    topic: "disclaimer",
    severity: "notice",
    message: AGREEMENT_NOT_ENFORCEABLE_MESSAGE,
  });
  return { findings, attorneyRecommended };
}

export function nextLifecycleAfterQuestions(): AgreementLifecycleStatus {
  return "DRAFT";
}

export function lifecycleAfterDraftSaved(): AgreementLifecycleStatus {
  return "RISK_REVIEW";
}

export function awaitingActionStatuses(): AgreementLifecycleStatus[] {
  return ["QUESTIONS", "DRAFT", "RISK_REVIEW", "OWNER_REVIEW", "LEGAL_WARNING", "READY", "SENT"];
}
