/**
 * Canonical recommendation catalog used by Business Health, Coach,
 * recommendation mutations, and the Chief of Staff.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { partitionRecommendations } from "@/lib/bsos-actions";
import { buildBsosRecommendations, type BsosFacts, type BsosRecommendation } from "@/lib/bsos";
import { loadWorkforceSnapshot } from "@/lib/workforce-data";

type Db = PrismaClient | Prisma.TransactionClient;

export type CanonicalRecommendationCatalog = {
  facts: BsosFacts;
  recommendations: BsosRecommendation[];
  activeRecommendations: BsosRecommendation[];
  historyRecommendations: BsosRecommendation[];
  states: Array<{ recommendationKey: string; status: string; evidenceKey?: string | null }>;
  workforceRecommendationKeys: string[];
};

export function mergeCatalogRecommendations(
  facts: BsosFacts,
  workforceRecommendations: BsosRecommendation[],
): BsosRecommendation[] {
  return [...buildBsosRecommendations(facts), ...workforceRecommendations].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );
}

export async function loadCanonicalRecommendationCatalog(
  db: Db,
  businessId: string,
): Promise<CanonicalRecommendationCatalog> {
  const { loadBsosFacts } = await import("@/lib/bsos-data");
  const [facts, workforce, states] = await Promise.all([
    loadBsosFacts(db as PrismaClient, businessId),
    loadWorkforceSnapshot(db, businessId),
    db.bsosRecommendationState.findMany({ where: { businessId } }),
  ]);
  const recommendations = mergeCatalogRecommendations(facts, workforce.recommendations);
  const { active, history } = partitionRecommendations(recommendations, states);
  return {
    facts,
    recommendations,
    activeRecommendations: active,
    historyRecommendations: history,
    states,
    workforceRecommendationKeys: workforce.recommendations.map((item) => item.key),
  };
}

export async function findCatalogRecommendation(
  db: Db,
  businessId: string,
  key: string,
) {
  const catalog = await loadCanonicalRecommendationCatalog(db, businessId);
  return catalog.recommendations.find((item) => item.key === key) ?? null;
}
