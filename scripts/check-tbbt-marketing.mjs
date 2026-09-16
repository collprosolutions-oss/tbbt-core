/**
 * Focused verification for the TBBT corporate marketing website.
 *
 * Hostname helpers, honest copy, public-path allowlisting, and CollPro
 * `/` preservation. HTTP checks run when APP_URL is reachable.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-tbbt-marketing.mjs
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  extraTbbtMarketingHosts,
  isCollProPublicHost,
  isTbbtMarketingHost,
  isTbbtMarketingIndexableHost,
  isTbbtMarketingPublicPath,
  shouldServeTbbtMarketingHome,
  tbbtCanonicalUrl,
  tbbtMarketingHomeHref,
  tbbtMarketingRobots,
  TBBT_MARKETING_PUBLIC_PATHS,
} = await import("@/lib/tbbt-marketing-host");
const {
  TBBT_CORE_FEATURES,
  TBBT_FOUNDER_PRICE_LABEL,
  TBBT_NAV,
  TBBT_POSITIONING,
  TBBT_PRICING_FEATURES,
  TBBT_SIGN_IN_HREF,
  TBBT_SIGN_UP_HREF,
  TBBT_TRADES,
} = await import("@/lib/tbbt-marketing");
const { tbbtMarketingMetadata } = await import("@/lib/tbbt-marketing-seo");
const { isPublicWebsitePath } = await import("@/lib/public-website-paths");
const { TBBT_FOUNDER_PLAN_PRICE_LABEL, TBBT_FOUNDER_TRIAL_DAYS } = await import(
  "@/lib/saas-billing/founder-price"
);
const { TRADE_CODES } = await import("@/lib/trades");

const APP_URL = process.env.APP_URL ?? "http://localhost:43217";

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

console.log("\nUNIT — Hostname routing");
check(
  "tbbtools.com is the TBBT marketing host and is indexable",
  isTbbtMarketingHost("tbbtools.com") &&
    isTbbtMarketingHost("www.tbbtools.com") &&
    isTbbtMarketingIndexableHost("tbbtools.com") &&
    isTbbtMarketingIndexableHost("www.tbbtools.com:443"),
);
check(
  "collproreno.com is never the TBBT marketing homepage",
  isCollProPublicHost("www.collproreno.com") &&
    !shouldServeTbbtMarketingHome("collproreno.com") &&
    !shouldServeTbbtMarketingHome("www.collproreno.com", {
      marketingSite: "1",
      extraHosts: "collproreno.com",
    }),
);
check(
  "localhost stays CollPro unless TBBT_MARKETING_SITE or TBBT_MARKETING_HOST is set",
  !shouldServeTbbtMarketingHome("localhost:43217") &&
    shouldServeTbbtMarketingHome("localhost", { marketingSite: "1" }) &&
    shouldServeTbbtMarketingHome("localhost", { extraHosts: "localhost" }),
);
check(
  "Preview vercel.app is not TBBT home without an explicit extra host",
  !isTbbtMarketingHost("collpro-reno-git-branch-team.vercel.app") &&
    !shouldServeTbbtMarketingHome("collpro-reno-git-branch-team.vercel.app") &&
    shouldServeTbbtMarketingHome("collpro-reno-git-branch-team.vercel.app", {
      extraHosts: "collpro-reno-git-branch-team.vercel.app",
    }),
);
check(
  "Extra hosts parse a comma list and ignore junk",
  extraTbbtMarketingHosts("preview.example, localhost:43217")[0] ===
    "preview.example" && extraTbbtMarketingHosts("https://evil.example/path").length === 0,
);
check(
  "Marketing home href is / on tbbtools.com and /home elsewhere",
  tbbtMarketingHomeHref("tbbtools.com") === "/" &&
    tbbtMarketingHomeHref("localhost") === "/home",
);
check(
  "Canonical URLs always point at https://tbbtools.com",
  tbbtCanonicalUrl("/") === "https://tbbtools.com/" &&
    tbbtCanonicalUrl("/home") === "https://tbbtools.com/" &&
    tbbtCanonicalUrl("/pricing") === "https://tbbtools.com/pricing",
);
check(
  "Off-canonical hosts noindex TBBT marketing; tbbtools.com indexes",
  tbbtMarketingRobots("localhost").index === false &&
    tbbtMarketingRobots("www.collproreno.com").index === false &&
    tbbtMarketingRobots("tbbtools.com").index === true,
);

console.log("\nUNIT — Public paths and CollPro safety");
check(
  "Every marketing inner path is public and exact",
  TBBT_MARKETING_PUBLIC_PATHS.every(
    (path) => isTbbtMarketingPublicPath(path) && isPublicWebsitePath(path),
  ) &&
    !isTbbtMarketingPublicPath("/features/extra") &&
    !isPublicWebsitePath("/dashboard") &&
    !isPublicWebsitePath("/setup") &&
    isPublicWebsitePath("/") &&
    isPublicWebsitePath("/robots.txt") &&
    isPublicWebsitePath("/sitemap.xml"),
);

const homeSrc = readRepo("src/app/page.tsx");
const hireSrc = readRepo("src/app/hire/[slug]/page.tsx");
const proxySrc = readRepo("src/proxy.ts");
check(
  "CollPro homepage and /hire/[slug] still exist",
  homeSrc.includes("PublicHome") &&
    homeSrc.includes("COLLPRO_RENO_DISPLAY_NAME") &&
    hireSrc.includes("<PublicHome") &&
    homeSrc.includes("shouldServeTbbtMarketingHome"),
);
check(
  "Auth proxy still treats public website paths as unauthenticated-safe",
  proxySrc.includes("isPublicWebsitePath(pathname) || isStripeWebhookPath(pathname)"),
);

console.log("\nSTATIC — Honest product claims");
check(
  "Nav is Home Features Trades Pricing About Resources",
  TBBT_NAV.map((item) => item.label).join(" ") ===
    "Home Features Trades Pricing About Resources",
);
check(
  "Auth CTAs reuse existing /sign-in and /sign-up",
  TBBT_SIGN_IN_HREF === "/sign-in" && TBBT_SIGN_UP_HREF === "/sign-up",
);
check(
  "Positioning is the trades OS, not handyman-only",
  TBBT_POSITIONING.includes("Business Operating System for the Trades") &&
    !TBBT_TRADES.every((trade) => trade.name === "Handyman"),
);
check(
  "Handyman is available; Cleaning is coming next; others are planned",
  TBBT_TRADES.find((trade) => trade.name === "Handyman")?.status === "available" &&
    TBBT_TRADES.find((trade) => trade.name === "Cleaning")?.status ===
      "coming-next" &&
    TBBT_TRADES.filter((trade) => trade.status === "available").length === 1 &&
    TRADE_CODES.length === 1 &&
    TRADE_CODES[0] === "HANDYMAN",
);
check(
  "Launch pricing is the Founder Plan at $49/month with a 30-day trial",
  TBBT_FOUNDER_PRICE_LABEL === TBBT_FOUNDER_PLAN_PRICE_LABEL &&
    TBBT_FOUNDER_PRICE_LABEL === "$49/month" &&
    TBBT_FOUNDER_TRIAL_DAYS === 30 &&
    TBBT_PRICING_FEATURES.some((item) => item.includes("30-day")),
);

const pricingSrc = readRepo("src/components/tbbt-marketing/pricing.tsx");
const homeMarketingSrc = readRepo("src/components/tbbt-marketing/home.tsx");
const homeCssSrc = readRepo("src/components/tbbt-marketing/tbbt-home.css");
const marketingLibSrc = readRepo("src/lib/tbbt-marketing.ts");
const previewSrc = readRepo("src/components/tbbt-marketing/product-preview.tsx");
const resourcesSrc = readRepo("src/components/tbbt-marketing/resources.tsx");
const aboutSrc = readRepo("src/components/tbbt-marketing/about.tsx");
const videoSrc = readRepo("src/components/tbbt-marketing/watch-video.tsx");
const r2Src = readRepo("src/lib/business-storage/r2-cors.ts");
const headerSrc = readRepo("src/components/tbbt-marketing/header.tsx");
const marketingCssSrc = readRepo("src/components/tbbt-marketing/tbbt-marketing.css");
check(
  "Pricing page does not invent Starter / Business / Enterprise prices",
  !pricingSrc.includes("$29") &&
    !pricingSrc.includes("$79") &&
    !pricingSrc.includes("$129") &&
    pricingSrc.includes("TBBT_FOUNDER_PLAN_DISPLAY_NAME") &&
    pricingSrc.includes("No invented tiers"),
);
check(
  "Watch Video exists without a fabricated video URL",
  videoSrc.includes("Watch Video") &&
    !videoSrc.includes("youtube.com") &&
    !videoSrc.includes("vimeo.com") &&
    !videoSrc.includes("http"),
);
check(
  "Resources categories are coming soon, not fake articles",
  resourcesSrc.includes("Coming soon") &&
    !resourcesSrc.includes("download now") &&
    !resourcesSrc.includes(".pdf"),
);
check(
  "About names Daniel LeBlanc and does not invent stats",
  aboutSrc.includes("Daniel LeBlanc") &&
    aboutSrc.includes("third-generation carpenter") &&
    !aboutSrc.includes("customers served") &&
    !aboutSrc.includes("employees"),
);
check(
  "Header uses the real TBBT logo with an oversized overlapping treatment",
  headerSrc.includes('src="/brand/tbbt-logo.png"') &&
    headerSrc.includes("tbbt-brand") &&
    !headerSrc.includes("tbbt-logo-text") &&
    marketingCssSrc.includes("--tbbt-logo-h: 8.9rem") &&
    marketingCssSrc.includes("overflow: visible") &&
    marketingCssSrc.includes("position: absolute"),
);
check(
  "Home keeps BUILD / RUN / GROW and the connected lifecycle",
  homeMarketingSrc.includes("TBBT_PILLARS") &&
    homeMarketingSrc.includes("TBBT_WORKFLOW_STEPS") &&
    homeMarketingSrc.includes("TBBT_TRIAL_CTA_LABEL") &&
    homeMarketingSrc.includes("tbbt-hero-cinematic") &&
    homeCssSrc.includes("hero-workshop.png") &&
    homeMarketingSrc.includes("hero-tradespro.png") &&
    homeMarketingSrc.includes("tbbt-connected-arrow"),
);
check(
  "Homepage trade strip uses dedicated visual thumbnails, not chips",
  marketingLibSrc.includes("trade-handyman.png") &&
    marketingLibSrc.includes("trade-landscaping.png") &&
    marketingLibSrc.includes("trade-more.png") &&
    homeMarketingSrc.includes("tbbt-trade-strip") &&
    !homeMarketingSrc.includes("tbbt-chip"),
);
check(
  "GROW coaching visual is labeled Planned",
  previewSrc.includes("Planned") &&
    previewSrc.includes("grow-coach.png") &&
    previewSrc.includes("not a live AI"),
);
check(
  "Core feature cards match the requested set",
  TBBT_CORE_FEATURES.length === 10 &&
    TBBT_CORE_FEATURES.some((item) => item.title === "Website Builder") &&
    TBBT_CORE_FEATURES.some((item) => item.title === "Reports & Business Insights"),
);
check(
  "TBBT production origins are in the R2 browser-upload CORS list",
  r2Src.includes("https://tbbtools.com") &&
    r2Src.includes("https://www.tbbtools.com") &&
    r2Src.includes("https://www.collproreno.com"),
);

const seo = tbbtMarketingMetadata({
  page: "pricing",
  pathname: "/pricing",
  host: "www.collproreno.com",
});
check(
  "Marketing metadata canonicalizes to tbbtools.com and noindexes CollPro hosts",
  seo.alternates?.canonical === "https://tbbtools.com/pricing" &&
    seo.robots?.index === false,
);
const liveSeo = tbbtMarketingMetadata({
  page: "home",
  pathname: "/",
  host: "tbbtools.com",
});
check(
  "tbbtools.com homepage metadata is indexable with an absolute title",
  liveSeo.robots?.index === true &&
    typeof liveSeo.title === "object" &&
    liveSeo.title !== null &&
    "absolute" in liveSeo.title,
);

async function fetchMaybe(path, host) {
  try {
    const res = await fetch(`${APP_URL}${path}`, {
      redirect: "manual",
      headers: host ? { host } : undefined,
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, body, location: res.headers.get("location") };
  } catch {
    return null;
  }
}

const reachable = await fetchMaybe("/sign-in");
if (!reachable) {
  console.log("\nHTTP — skipped (APP_URL is not reachable)");
} else {
  console.log("\nHTTP — TBBT marketing routes");
  const collproHome = await fetchMaybe("/");
  check(
    "Default / is not the TBBT marketing homepage off tbbtools.com",
    Boolean(
      collproHome &&
        !collproHome.body.includes("tbbt-site") &&
        (collproHome.body.includes("CollPro Reno") || collproHome.status >= 400),
    ),
  );

  for (const path of ["/home", "/features", "/trades", "/pricing", "/about", "/resources", "/privacy", "/terms", "/contact"]) {
    const page = await fetchMaybe(path);
    check(
      `${path} is reachable without sign-in`,
      Boolean(page && page.status === 200 && page.body.includes("TBBT")),
    );
  }

  const features = await fetchMaybe("/features");
  check(
    "Features page labels AI coaching as planned",
    Boolean(
      features &&
        features.body.includes("AI coaching") &&
        features.body.includes("Planned"),
    ),
  );
  const pricing = await fetchMaybe("/pricing");
  check(
    "Pricing HTTP page shows $49/month Founder Plan and signup",
    Boolean(
      pricing &&
        pricing.body.includes("$49/month") &&
        pricing.body.includes("/sign-up") &&
        !pricing.body.includes("$29"),
    ),
  );
  const homePreview = await fetchMaybe("/home");
  check(
    "Preview home uses existing signup, not a duplicate auth system",
    Boolean(
      homePreview &&
        homePreview.body.includes("/sign-up") &&
        homePreview.body.includes("/sign-in") &&
        homePreview.body.includes("Start Your Free 30-Day Trial"),
    ),
  );
  const robots = await fetchMaybe("/robots.txt");
  check(
    "robots.txt is public and does not bounce to sign-in",
    Boolean(
      robots &&
        robots.status === 200 &&
        /user-agent/i.test(robots.body) &&
        !robots.location?.includes("sign-in"),
    ),
  );
}

console.log(
  failed === 0
    ? `\nAll TBBT marketing checks passed (${passed}).`
    : `\n${passed} passed, ${failed} failed.`,
);
process.exit(failed > 0 ? 1 : 0);
