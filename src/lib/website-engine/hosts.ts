/**
 * Public host → Business resolution boundary.
 *
 * Verified custom domains are the only future non-CollPro hostname
 * mapping. UNVERIFIED bindings never authorize. This PR does not
 * provision DNS or mark a hostname verified.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { COLLPRO_RENO_SLUGS } from "@/lib/public-site";
import {
  isCollProPublicHost,
  isTbbtMarketingHost,
  shouldServeTbbtMarketingHome,
} from "@/lib/tbbt-marketing-host";

type Db = PrismaClient | Prisma.TransactionClient;

export type ResolvedPublicHost =
  | { kind: "marketing" }
  | { kind: "collpro"; slug: string }
  | { kind: "tenant"; slug: string; businessId: string }
  | { kind: "unknown" };

export async function resolvePublicHost(
  db: Db,
  host: string | null | undefined,
): Promise<ResolvedPublicHost> {
  const hostname = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!hostname) return { kind: "unknown" };
  if (shouldServeTbbtMarketingHome(hostname) || isTbbtMarketingHost(hostname)) {
    return { kind: "marketing" };
  }
  if (isCollProPublicHost(hostname)) {
    return { kind: "collpro", slug: COLLPRO_RENO_SLUGS[0] };
  }
  try {
    const binding = await db.websiteHostBinding.findFirst({
      where: { hostname, status: "VERIFIED" },
      select: { businessId: true, business: { select: { slug: true } } },
    });
    if (!binding) return { kind: "unknown" };
    return {
      kind: "tenant",
      slug: binding.business.slug,
      businessId: binding.businessId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/WebsiteHostBinding|does not exist/i.test(message)) return { kind: "unknown" };
    throw error;
  }
}
