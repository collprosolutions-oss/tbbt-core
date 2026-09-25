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
import {
  EMPTY_GROWTH_SNAPSHOT,
  type GrowthTurnSnapshot,
} from "@/lib/chief-of-staff/growth-snapshot";
import { loadWorkforceSnapshot, type WorkforceSnapshot } from "@/lib/workforce-data";

type Db = PrismaClient | Prisma.TransactionClient;

export type CanonicalRecommendationCatalog = {
  facts: BsosFacts;
  recommendations: BsosRecommendation[];
  activeRecommendations: BsosRecommendation[];
  historyRecommendations: BsosRecommendation[];
  states: Array<{ recommendationKey: string; status: string; evidenceKey?: string | null }>;
  workforceRecommendationKeys: string[];
  financial: FinancialTurnSnapshot;
  /** Same GrowthSource already loaded for BSOS counts. Null when not entitled or on loader failure. */
  growth: GrowthTurnSnapshot;
  /** Same snapshot already loaded for the catalog. Null only on loader failure. */
  workforceSnapshot: WorkforceSnapshot | null;
  workforceLoadError?: string;
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
  options?: { failWorkforceSnapshot?: boolean },
): Promise<CanonicalRecommendationCatalog> {
  const { loadBsosFactsBundle } = await import("@/lib/bsos-data");
  const [bundleResult, workforceResult, statesResult] = await Promise.allSettled([
    loadBsosFactsBundle(db as PrismaClient, businessId),
    options?.failWorkforceSnapshot
      ? Promise.reject(new Error("injected workforce snapshot failure"))
      : loadWorkforceSnapshot(db, businessId),
    db.bsosRecommendationState.findMany({ where: { businessId } }),
  ]);
  if (bundleResult.status === "rejected") {
    throw bundleResult.reason instanceof Error
      ? bundleResult.reason
      : new Error("Business Health facts could not be loaded.");
  }
  if (statesResult.status === "rejected") {
    throw statesResult.reason instanceof Error
      ? statesResult.reason
      : new Error("Recommendation states could not be loaded.");
  }
  const bundle = bundleResult.value;
  const states = statesResult.value;
  const workforce = workforceResult.status === "fulfilled" ? workforceResult.value : null;
  const workforceLoadError =
    workforceResult.status === "rejected"
      ? workforceResult.reason instanceof Error
        ? workforceResult.reason.message
        : "Workforce snapshot could not be loaded."
      : undefined;
  const recommendations = mergeCatalogRecommendations(bundle.facts, workforce?.recommendations ?? []);
  const { active, history } = partitionRecommendations(recommendations, states);
  return {
    facts: bundle.facts,
    recommendations,
    activeRecommendations: active,
    historyRecommendations: history,
    states,
    workforceRecommendationKeys: workforce?.recommendations.map((item) => item.key) ?? [],
    financial: bundle.financial ?? EMPTY_FINANCIAL_SNAPSHOT,
    growth: bundle.growth ?? EMPTY_GROWTH_SNAPSHOT,
    workforceSnapshot: workforce,
    workforceLoadError,
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
