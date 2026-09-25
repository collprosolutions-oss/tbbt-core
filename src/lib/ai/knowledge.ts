import type { Prisma, PrismaClient } from "@prisma/client";
import { AI_NOT_CONNECTED_MESSAGE, type StructuredAiOutput } from "@/lib/ai/types";
import { sanitizeAiText } from "@/lib/ai/sanitize";

type Db = PrismaClient | Prisma.TransactionClient;

export type KnowledgeGrounding = "approved" | "historical" | "inference" | "unknown";

export type KnowledgeHit = {
  id: string;
  title: string;
  category: string;
  trustState: string;
  sourceType: string;
  excerpt: string;
  scope: string;
  approvalState: string;
  knowledgeKind: string | null;
  grounding: KnowledgeGrounding;
};

export async function retrieveTenantKnowledge(
  db: Db,
  businessId: string,
  question: string,
  limit = 8,
): Promise<KnowledgeHit[]> {
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
    .slice(0, 8);
  const entries = await db.knowledgeEntry.findMany({
    where: {
      businessId,
      archived: false,
      scope: "BUSINESS",
    },
    orderBy: { updatedAt: "desc" },
    take: 80,
    select: {
      id: true,
      title: true,
      category: true,
      body: true,
      trustState: true,
      sourceType: true,
      scope: true,
      approvalState: true,
      knowledgeKind: true,
    },
  });

  const scored = entries
    .map((entry) => {
      const hay = `${entry.title} ${entry.body}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
      const approvedBoost = entry.approvalState === "APPROVED" ? 2 : 0;
      return { entry, score: score + approvedBoost };
    })
    .filter((row) => row.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ entry }) => ({
    id: entry.id,
    title: entry.title,
    category: entry.category,
    trustState: entry.trustState,
    sourceType: entry.sourceType,
    scope: entry.scope,
    approvalState: entry.approvalState,
    knowledgeKind: entry.knowledgeKind,
    grounding: groundingForEntry(entry),
    excerpt: sanitizeAiText(entry.body, 240),
  }));
}

function groundingForEntry(entry: {
  approvalState: string;
  sourceType: string;
  trustState: string;
}): KnowledgeGrounding {
  if (entry.approvalState === "APPROVED") return "approved";
  if (entry.sourceType === "TBBT_RECORD") return "historical";
  if (entry.trustState === "NEEDS_REVIEW" || entry.approvalState === "UNREVIEWED") return "inference";
  return "unknown";
}

export function answerKnowledgeFromEntries(
  question: string,
  hits: KnowledgeHit[],
): StructuredAiOutput {
  if (hits.length === 0) {
    return {
      text: `Unknown for this business. No authorized Knowledge entries match that question. TBBT will not use another tenant's knowledge or invent an answer. Question recorded as owner text: ${sanitizeAiText(question, 160)}`,
      stance: "FACT",
      citedFactKeys: [],
      notes: AI_NOT_CONNECTED_MESSAGE,
    };
  }
  const groups: Record<KnowledgeGrounding, KnowledgeHit[]> = {
    approved: hits.filter((hit) => hit.grounding === "approved"),
    historical: hits.filter((hit) => hit.grounding === "historical"),
    inference: hits.filter((hit) => hit.grounding === "inference"),
    unknown: hits.filter((hit) => hit.grounding === "unknown"),
  };
  const section = (label: string, rows: KnowledgeHit[]) =>
    rows.length
      ? `${label}\n${rows
          .map((hit) => `- ${hit.title} [${hit.trustState} / ${hit.approvalState}]: ${hit.excerpt}`)
          .join("\n")}`
      : "";
  const text = [
    "From this business's Knowledge Hub only. Grounding is labeled; TBBT does not invent missing policy.",
    section("Approved knowledge", groups.approved),
    section("Historical evidence", groups.historical),
    section("Inference (not approved policy)", groups.inference),
    section("Unknown / unlabeled", groups.unknown),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    text,
    stance: groups.approved.length ? "FACT" : "MIXED",
    citedFactKeys: hits.map((hit) => hit.id),
    notes: AI_NOT_CONNECTED_MESSAGE,
  };
}

export function extractKnowledgeFoundation(input: { title: string; body: string; category: string }) {
  const text = `${input.title}\n${input.body}`;
  const concepts = Array.from(
    new Set(
      text
        .split(/[^A-Za-z0-9/&+-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 3)
        .slice(0, 8),
    ),
  ).map((label) => ({
    label,
    kind: /warn|never|except|don't|do not/i.test(label) ? "WARNING" : "CONCEPT",
  }));
  const assertions = [
    {
      statement: input.body.trim().slice(0, 280) || input.title,
      stance: "CLAIM" as const,
      confidence: "UNKNOWN" as const,
    },
  ];
  return { concepts, assertions, category: input.category };
}
