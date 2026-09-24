import type { Prisma, PrismaClient } from "@prisma/client";
import { draftMarketingContent, type MarketingDraft, type MarketingDraftInput } from "@/lib/marketing-draft";
import { runAiTask, type AiServiceActor } from "@/lib/ai/service";
import { AI_NOT_CONNECTED_MESSAGE } from "@/lib/ai/types";

type Db = PrismaClient | Prisma.TransactionClient;

export type MarketingDraftVariation = MarketingDraft & {
  variation: "A" | "B" | "C";
  hashtags: string[];
  cta: string;
};

function localHashtags(input: MarketingDraftInput) {
  const city = input.city?.trim().replace(/\s+/g, "") || "";
  return [
    "#LocalHandyman",
    city ? `#${city}` : "#HomeRepair",
    "#SmallBusiness",
  ].slice(0, 3);
}

function ctaFor(input: MarketingDraftInput) {
  return input.city
    ? `Ask about ${input.serviceName || "this service"} in ${input.city}.`
    : `Ask about ${input.serviceName || "this service"}.`;
}

export function draftMarketingVariations(input: MarketingDraftInput): MarketingDraftVariation[] {
  const base = draftMarketingContent(input);
  const tags = localHashtags(input);
  const cta = ctaFor(input);
  return [
    { ...base, variation: "A", hashtags: tags, cta },
    {
      ...base,
      variation: "B",
      title: `${base.title} — local update`,
      body: `${base.body}\n\n${cta}`,
      hashtags: tags,
      cta,
    },
    {
      ...base,
      variation: "C",
      title: `Homeowner note: ${input.serviceName || input.workPerformed || "completed work"}`,
      body: `${base.body}\n\nHashtags stay local and generic. Nothing is published.`,
      hashtags: tags,
      cta,
    },
  ];
}

export function weeklyMarketingPlanFromActivity(input: {
  completedJobs: number;
  approvedPhotos: number;
  reviews: number;
  campaigns: number;
  serviceAreas: number;
}) {
  const items = [];
  if (input.completedJobs > 0) {
    items.push({
      day: "Monday",
      title: "Completed-job post",
      why: `${input.completedJobs} completed job(s) are on file.`,
    });
  }
  if (input.approvedPhotos > 0) {
    items.push({
      day: "Wednesday",
      title: "Photo story draft",
      why: `${input.approvedPhotos} marketing-approved photo(s) can be attached.`,
    });
  }
  if (input.reviews > 0) {
    items.push({
      day: "Friday",
      title: "Review-to-content draft",
      why: `${input.reviews} recorded review(s) exist. Do not copy review text without permission.`,
    });
  }
  if (input.campaigns > 0 || input.serviceAreas > 0) {
    items.push({
      day: "Weekend",
      title: "Service-area reminder draft",
      why: "Campaign or service-area records exist. This is an internal plan, not an ad buy.",
    });
  }
  if (items.length === 0) {
    items.push({
      day: "This week",
      title: "Record more completed work first",
      why: "Not enough recorded marketing-ready activity to plan posts.",
    });
  }
  return {
    mode: "TEMPLATE" as const,
    message: AI_NOT_CONNECTED_MESSAGE,
    publishable: false as const,
    items,
  };
}

export async function weeklyMarketingPlanWithAi(
  db: Db,
  actor: AiServiceActor,
  input: Parameters<typeof weeklyMarketingPlanFromActivity>[0],
  idempotencyKey: string,
) {
  const fallbackText = weeklyMarketingPlanFromActivity(input)
    .items.map((item) => `${item.day}: ${item.title} — ${item.why}`)
    .join("\n");
  const result = await runAiTask(db, actor, {
    taskType: "WEEKLY_PLAN",
    system:
      "Draft an internal weekly marketing plan from recorded TBBT activity only. Return JSON {text, stance, citedFactKeys, notes}. Never invent audience size, ad spend, or published results. Content remains DRAFT.",
    user: JSON.stringify(input),
    inputSummary: "weekly marketing plan",
    idempotencyKey,
    fallback: {
      text: fallbackText,
      stance: "RECOMMENDATION",
      citedFactKeys: ["completedJobs", "approvedPhotos", "reviews"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["completedJobs", "approvedPhotos", "reviews", "campaigns", "serviceAreas"],
  });
  return {
    ...weeklyMarketingPlanFromActivity(input),
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? undefined : result.output?.text ?? fallbackText,
    publishable: false as const,
  };
}

export function campaignIdeasFromActivity(input: {
  leadSources: string[];
  completedJobs: number;
  unpaidInvoices: number;
}) {
  const ideas = [];
  if (input.completedJobs > 0) {
    ideas.push("Turn a completed job with approved photos into a DRAFT social post.");
  }
  if (input.leadSources.includes("REFERRAL")) {
    ideas.push("Recorded referrals already convert. Draft a referral thank-you, do not auto-send.");
  }
  if (input.leadSources.includes("GOOGLE") || input.leadSources.includes("WEBSITE")) {
    ideas.push("Website/Google leads are already attributed. Improve the public site draft, not an ad account.");
  }
  if (input.unpaidInvoices > 0) {
    ideas.push("Unpaid invoices are a collections task, not a marketing campaign.");
  }
  if (ideas.length === 0) {
    ideas.push("No recorded campaign-ready activity yet. TBBT will not invent audience size or ad results.");
  }
  return {
    mode: "TEMPLATE" as const,
    message: AI_NOT_CONNECTED_MESSAGE,
    publishable: false as const,
    ideas,
  };
}

export async function campaignIdeasWithAi(
  db: Db,
  actor: AiServiceActor,
  input: Parameters<typeof campaignIdeasFromActivity>[0],
  idempotencyKey: string,
) {
  const fallback = campaignIdeasFromActivity(input);
  const result = await runAiTask(db, actor, {
    taskType: "CAMPAIGN_IDEAS",
    system:
      "Suggest internal campaign ideas from recorded TBBT activity only. Return JSON {text, stance, citedFactKeys, notes}. Never invent ad results or spend money. Ideas stay DRAFT.",
    user: JSON.stringify(input),
    inputSummary: "campaign ideas",
    idempotencyKey,
    fallback: {
      text: fallback.ideas.join("\n"),
      stance: "RECOMMENDATION",
      citedFactKeys: ["completedJobs", "unpaidInvoices"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["completedJobs", "unpaidInvoices", "leadSources"],
  });
  return {
    ...fallback,
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? undefined : result.output?.text ?? fallback.ideas.join("\n"),
    publishable: false as const,
  };
}

export async function draftMarketingVariationsWithAi(
  db: Db,
  actor: AiServiceActor,
  input: MarketingDraftInput,
  idempotencyKey: string,
) {
  const fallback = draftMarketingVariations(input);
  const result = await runAiTask(db, actor, {
    taskType: "MARKETING_DRAFT",
    system:
      "Draft social-post variations from recorded TBBT context. Return JSON {text, stance, citedFactKeys, notes}. Never invent reviews, customer names, or publish anything.",
    user: JSON.stringify({
      serviceName: input.serviceName,
      workPerformed: input.workPerformed,
      city: input.city,
      photoCount: input.photoCount,
    }),
    inputSummary: "marketing draft variations",
    idempotencyKey,
    fallback: {
      text: fallback.map((row) => row.body).join("\n\n"),
      stance: "RECOMMENDATION",
      citedFactKeys: ["workPerformed"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["workPerformed", "city", "photoCount"],
  });
  return {
    variations: fallback,
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? undefined : result.output?.text ?? fallback.map((row) => row.body).join("\n\n"),
    publishable: false as const,
  };
}
