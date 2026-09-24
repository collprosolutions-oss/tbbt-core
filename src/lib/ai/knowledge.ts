import type { Prisma, PrismaClient } from "@prisma/client";
import { AI_NOT_CONNECTED_MESSAGE, type StructuredAiOutput } from "@/lib/ai/types";
import { sanitizeAiText } from "@/lib/ai/sanitize";

type Db = PrismaClient | Prisma.TransactionClient;

export type KnowledgeHit = {
  id: string;
  title: string;
  category: string;
  trustState: string;
  sourceType: string;
  excerpt: string;
  scope: string;
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
    },
  });

  const scored = entries
    .map((entry) => {
      const hay = `${entry.title} ${entry.body}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0);
      return { entry, score };
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
    excerpt: sanitizeAiText(entry.body, 240),
  }));
}

export function answerKnowledgeFromEntries(
  question: string,
  hits: KnowledgeHit[],
): StructuredAiOutput {
  if (hits.length === 0) {
    return {
      text: `No authorized Knowledge entries for this business match that question. TBBT will not use another tenant's knowledge or invent an answer. Question recorded as owner text: ${sanitizeAiText(question, 160)}`,
      stance: "FACT",
      citedFactKeys: [],
      notes: AI_NOT_CONNECTED_MESSAGE,
    };
  }
  const lines = hits.map(
    (hit) =>
      `${hit.title} [${hit.trustState} / ${hit.sourceType}]: ${hit.excerpt}`,
  );
  return {
    text: `From this business's Knowledge Hub only:\n${lines.join("\n")}\n\nThese are retrieved entries, not verified just because they were returned. Trust state stays on each entry.`,
    stance: "FACT",
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
