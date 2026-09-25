/**
 * Growth AI helpers. Template-first. Never invent performance numbers.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { runAiTask, type AiServiceActor } from "@/lib/ai/service";
import { AI_NOT_CONNECTED_MESSAGE } from "@/lib/ai/types";
import type { CampaignPerformance } from "@/lib/growth-engine";
import { COST_ROI_UNAVAILABLE_MESSAGE, type GrowthRecommendation } from "@/lib/growth";

type Db = PrismaClient | Prisma.TransactionClient;

export type GrowthExplainInput = {
  leads: number;
  estimates: number;
  collected: number;
  invoiced: number;
  campaigns: Array<Pick<CampaignPerformance, "name" | "leads" | "wins" | "collectedRevenue" | "costAvailable" | "roi">>;
  recommendations: Array<Pick<GrowthRecommendation, "title" | "why">>;
};

export function explainGrowthPerformance(input: GrowthExplainInput) {
  const lines = [
    `Recorded leads: ${input.leads}.`,
    `Recorded estimates: ${input.estimates}.`,
    `Invoiced revenue (SENT + PAID): ${input.invoiced.toFixed(2)}.`,
    `Collected revenue (PAID only): ${input.collected.toFixed(2)}.`,
  ];
  for (const campaign of input.campaigns.slice(0, 5)) {
    const roi = campaign.costAvailable
      ? `ROI ${campaign.roi}`
      : COST_ROI_UNAVAILABLE_MESSAGE;
    lines.push(
      `${campaign.name}: ${campaign.leads} leads, ${campaign.wins} wins, collected ${campaign.collectedRevenue.toFixed(2)}. ${roi}`,
    );
  }
  if (input.recommendations[0]) {
    lines.push(`Next recorded action: ${input.recommendations[0].title}. ${input.recommendations[0].why}`);
  }
  return {
    mode: "TEMPLATE" as const,
    publishable: false as const,
    message: AI_NOT_CONNECTED_MESSAGE,
    text: lines.join(" "),
    stance: "FACT" as const,
  };
}

export function proposeCampaignAngle(input: GrowthExplainInput) {
  const top = input.campaigns.find((row) => row.wins > 0) ?? input.campaigns[0];
  const rec = input.recommendations[0];
  const text = rec
    ? `Use recorded activity only: ${rec.title}. ${rec.why} Do not invent audience size or ad results.`
    : top
      ? `Lean into ${top.name}, which already has ${top.wins} recorded win(s) from ${top.leads} lead(s).`
      : "Record more leads and estimates before proposing a campaign angle.";
  return {
    mode: "TEMPLATE" as const,
    publishable: false as const,
    message: AI_NOT_CONNECTED_MESSAGE,
    text,
    stance: "RECOMMENDATION" as const,
  };
}

export async function explainGrowthPerformanceWithAi(
  db: Db,
  actor: AiServiceActor,
  input: GrowthExplainInput,
  idempotencyKey: string,
) {
  const fallback = explainGrowthPerformance(input);
  const result = await runAiTask(db, actor, {
    taskType: "GROWTH_EXPLAIN",
    system:
      "Explain recorded TBBT growth performance only. Return JSON {text, stance, citedFactKeys, notes}. Never invent ROI, spend, rankings, or audience size. If cost is missing, say cost/ROI unavailable.",
    user: JSON.stringify(input),
    inputSummary: "growth performance explanation",
    idempotencyKey,
    fallback: {
      text: fallback.text,
      stance: "FACT",
      citedFactKeys: ["leads", "estimates", "collected", "invoiced"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["leads", "estimates", "collected", "invoiced", "campaigns"],
  });
  return {
    ...fallback,
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? fallback.text : result.output?.text ?? fallback.text,
  };
}

export async function proposeCampaignAngleWithAi(
  db: Db,
  actor: AiServiceActor,
  input: GrowthExplainInput,
  idempotencyKey: string,
) {
  const fallback = proposeCampaignAngle(input);
  const result = await runAiTask(db, actor, {
    taskType: "GROWTH_CAMPAIGN_ANGLE",
    system:
      "Propose one internal campaign angle from recorded TBBT facts. Return JSON {text, stance, citedFactKeys, notes}. Never invent performance data. Content remains a draft.",
    user: JSON.stringify(input),
    inputSummary: "growth campaign angle",
    idempotencyKey,
    fallback: {
      text: fallback.text,
      stance: "RECOMMENDATION",
      citedFactKeys: ["recommendations", "campaigns"],
      notes: AI_NOT_CONNECTED_MESSAGE,
    },
    allowedFactKeys: ["leads", "campaigns", "recommendations"],
  });
  return {
    ...fallback,
    status: result.status,
    mode: result.connected && result.status === "COMPLETED" ? ("AI" as const) : ("TEMPLATE" as const),
    message: result.message,
    text: result.status === "PENDING" ? fallback.text : result.output?.text ?? fallback.text,
  };
}
