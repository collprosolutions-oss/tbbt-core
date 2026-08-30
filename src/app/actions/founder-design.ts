"use server";

/**
 * Founder Design Mode mutations. Every export here is gated by
 * requireFounderAccess() (src/lib/founder-access.ts) -- a platform-level
 * flag on User, completely independent of Membership/MembershipRole.
 * These actions never touch any business/tenant record; they only ever
 * read/write the founder's OWN FounderDesignOverride rows, keyed by their
 * own userId + a fixed pageKey.
 */
import { revalidatePath } from "next/cache";
import { requireFounderAccess } from "@/lib/founder-access";
import {
  isFounderPageKey,
  sanitizeFounderPageTokens,
  type FounderPageKey,
  type FounderPageTokens,
} from "@/lib/founder-design";
import { prisma } from "@/lib/prisma";

export type FounderDesignActionState = {
  error?: string;
  tokens?: FounderPageTokens;
};

const PAGE_PATHS: Record<FounderPageKey, string> = {
  dashboard: "/dashboard",
  requests: "/requests",
  customers: "/customers",
  estimates: "/estimates",
  jobs: "/jobs",
  invoices: "/invoices",
};

function assertPageKey(pageKey: string): FounderPageKey {
  if (!isFounderPageKey(pageKey)) {
    throw new Error("Unknown Founder Design Mode page.");
  }
  return pageKey;
}

/**
 * Persists the founder's approved token values for one page. Sanitizes
 * (clamps/validates) the incoming payload independently of whatever the
 * client believed it was sending -- see sanitizeFounderPageTokens().
 */
export async function saveFounderDesignTokens(
  pageKeyRaw: string,
  tokens: unknown,
): Promise<FounderDesignActionState> {
  const founder = await requireFounderAccess();
  const pageKey = assertPageKey(pageKeyRaw);
  const clean = sanitizeFounderPageTokens(pageKey, tokens);

  await prisma.founderDesignOverride.upsert({
    where: { userId_pageKey: { userId: founder.id, pageKey } },
    create: { userId: founder.id, pageKey, tokens: clean },
    update: { tokens: clean },
  });

  revalidatePath(PAGE_PATHS[pageKey]);
  return { tokens: clean };
}

/**
 * Clears one section (kpi / table / spacing / panel) of the founder's
 * saved override for a page, restoring that section to the approved
 * default while leaving any OTHER saved section untouched.
 */
export async function resetFounderDesignSection(
  pageKeyRaw: string,
  section: "kpi" | "tableDensity" | "sectionGap" | "panelWidth",
): Promise<FounderDesignActionState> {
  const founder = await requireFounderAccess();
  const pageKey = assertPageKey(pageKeyRaw);

  const existing = await prisma.founderDesignOverride.findUnique({
    where: { userId_pageKey: { userId: founder.id, pageKey } },
  });

  const current = sanitizeFounderPageTokens(pageKey, existing?.tokens ?? {});
  delete current[section];

  if (Object.keys(current).length === 0) {
    await prisma.founderDesignOverride.deleteMany({
      where: { userId: founder.id, pageKey },
    });
  } else {
    await prisma.founderDesignOverride.upsert({
      where: { userId_pageKey: { userId: founder.id, pageKey } },
      create: { userId: founder.id, pageKey, tokens: current },
      update: { tokens: current },
    });
  }

  revalidatePath(PAGE_PATHS[pageKey]);
  return { tokens: current };
}

/** Restores the ENTIRE page to its approved default design (deletes the saved override row, if any). */
export async function resetFounderDesignPage(pageKeyRaw: string): Promise<FounderDesignActionState> {
  const founder = await requireFounderAccess();
  const pageKey = assertPageKey(pageKeyRaw);

  await prisma.founderDesignOverride.deleteMany({
    where: { userId: founder.id, pageKey },
  });

  revalidatePath(PAGE_PATHS[pageKey]);
  return { tokens: {} };
}

/**
 * Not currently called from the client (each page reads its own saved
 * override server-side at render time), but exported for completeness /
 * potential future client-side refresh use -- still fully gated.
 */
export async function getFounderDesignTokens(pageKeyRaw: string): Promise<FounderPageTokens> {
  const founder = await requireFounderAccess();
  const pageKey = assertPageKey(pageKeyRaw);
  const existing = await prisma.founderDesignOverride.findUnique({
    where: { userId_pageKey: { userId: founder.id, pageKey } },
  });
  return sanitizeFounderPageTokens(pageKey, existing?.tokens ?? {});
}
