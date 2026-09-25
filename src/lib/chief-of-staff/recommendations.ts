/**
 * Canonical recommendation catalog used by Business Health, Coach,
 * recommendation mutations, and the Chief of Staff.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { partitionRecommendations } from "@/lib/bsos-actions";
import { buildBsosRecommendations, type BsosFacts, type BsosRecommendation } from "@/lib/bsos";
import {
  EMPTY_FINANCIAL_SNAPSHOT,
  type FinancialTurnSnapshot,
} from "@/lib/chief-of-staff/financial-snapshot";
import { loadWorkforceSnapshot } from "@/lib/workforce-data";

type Db = PrismaClient | Prisma.TransactionClient;

export type CanonicalRecommendationCatalog = {
  facts: BsosFacts;
  recommendations: BsosRecommendation[];
  activeRecommendations: BsosRecommendation[];
  historyRecommendations: BsosRecommendation[];
  states: Array<{ recommendationKey: string; status: string; evidenceKey?: string | null }>;
  workforceRecommendationKeys: string[];
  financial: FinancialTurnSnapshot;
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
  const { loadBsosFactsBundle } = await import("@/lib/bsos-data");
  const [bundle, workforce, states] = await Promise.all([
    loadBsosFactsBundle(db as PrismaClient, businessId),
    loadWorkforceSnapshot(db, businessId),
    db.bsosRecommendationState.findMany({ where: { businessId } }),
  ]);
  const recommendations = mergeCatalogRecommendations(bundle.facts, workforce.recommendations);
  const { active, history } = partitionRecommendations(recommendations, states);
  return {
    facts: bundle.facts,
    recommendations,
    activeRecommendations: active,
    historyRecommendations: history,
    states,
    workforceRecommendationKeys: workforce.recommendations.map((item) => item.key),
    financial: bundle.financial ?? EMPTY_FINANCIAL_SNAPSHOT,
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
