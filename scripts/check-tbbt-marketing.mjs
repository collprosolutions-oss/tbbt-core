/**
 * Focused verification for the TBBT corporate marketing website.
 *
 * Hostname helpers, honest copy, public-path allowlisting, and CollPro
 * `/` preservation. HTTP checks run when APP_URL is reachable.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-tbbt-marketing.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  extraTbbtMarketingHosts,
  isCollProPublicHost,
  isTbbtMarketingApexHost,
  isTbbtMarketingHost,
  isTbbtMarketingIndexableHost,
  isTbbtMarketingPublicPath,
  shouldServeTbbtMarketingHome,
  tbbtApexWwwRedirectLocation,
  tbbtCanonicalUrl,
  tbbtMarketingHomeHref,
  tbbtMarketingRobots,
  TBBT_MARKETING_PUBLIC_PATHS,
} = await import("@/lib/tbbt-marketing-host");
const {
  TBBT_ADDITIONAL_FEATURES,
  TBBT_COMING_FEATURES,
  TBBT_CORE_FEATURES,
  TBBT_FOUNDER_NO_CARD,
  TBBT_FOUNDER_PRICE_LABEL,
  TBBT_FOUNDER_PROTECTION,
  TBBT_HERO_OFFER,
  TBBT_HOW_IT_WORKS,
  TBBT_LEGAL_NAV,
  TBBT_NAV,
  TBBT_POSITIONING,
  TBBT_PRICING_FEATURES,
  TBBT_SEE_WHAT_YOU_GET_LABEL,
  TBBT_SIGN_IN_HREF,
  TBBT_SIGN_UP_HREF,
  TBBT_TRADES,
  TBBT_TRADES_PAGE_CAPABILITIES,
  TBBT_TRADES_PAGE_CARDS,
  TBBT_TRADES_PAGE_CTA_HEADLINE,
  TBBT_TRADES_PAGE_CTA_SRC,
  TBBT_TRADES_PAGE_HERO_PRO_SRC,
  TBBT_TRADES_PAGE_PLATFORM_SRC,
  TBBT_TRADES_PAGE_ROADMAP_LABEL,
  TBBT_TRIAL_CTA_LABEL,
  TBBT_TRIAL_NAV_LABEL,
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
  "www.tbbtool.com is the TBBT marketing host and is indexable",
  isTbbtMarketingHost("www.tbbtool.com") &&
    isTbbtMarketingHost("tbbtool.com") &&
    isTbbtMarketingIndexableHost("www.tbbtool.com") &&
    isTbbtMarketingIndexableHost("www.tbbtool.com:443") &&
    !isTbbtMarketingIndexableHost("tbbtool.com"),
);
check(
  "Legacy tbbtools.com hosts still render TBBT but are not canonical",
  isTbbtMarketingHost("tbbtools.com") &&
    isTbbtMarketingHost("www.tbbtools.com") &&
    !isTbbtMarketingIndexableHost("tbbtools.com") &&
    !isTbbtMarketingIndexableHost("www.tbbtools.com"),
);
check(
  "collproreno.com is never the TBBT marketing homepage",
  isCollProPublicHost("www.collproreno.com") &&
    isCollProPublicHost("collproreno.com") &&
    !shouldServeTbbtMarketingHome("collproreno.com") &&
    !shouldServeTbbtMarketingHome("www.collproreno.com", {
      marketingSite: "1",
      extraHosts: "collproreno.com",
    }) &&
    !isTbbtMarketingHost("www.collproreno.com"),
);
check(
  "Same-project coexistence: TBBT and CollPro hosts never share a homepage",
  shouldServeTbbtMarketingHome("www.tbbtool.com") &&
    shouldServeTbbtMarketingHome("tbbtool.com") &&
    !shouldServeTbbtMarketingHome("www.collproreno.com") &&
    !shouldServeTbbtMarketingHome("collproreno.com") &&
    tbbtMarketingHomeHref("www.tbbtool.com") === "/" &&
    tbbtMarketingHomeHref("www.collproreno.com") === "/home",
);
check(
  "tbbtool.com apex 308s to www.tbbtool.com; CollPro apex is unchanged",
  isTbbtMarketingApexHost("tbbtool.com") &&
    !isTbbtMarketingApexHost("www.tbbtool.com") &&
    !isTbbtMarketingApexHost("collproreno.com") &&
    tbbtApexWwwRedirectLocation("tbbtool.com", "/") === "https://www.tbbtool.com/" &&
    tbbtApexWwwRedirectLocation("tbbtool.com", "/pricing", "?ref=1") ===
      "https://www.tbbtool.com/pricing?ref=1" &&
    tbbtApexWwwRedirectLocation("www.tbbtool.com", "/") === null &&
    tbbtApexWwwRedirectLocation("collproreno.com", "/") === null &&
    tbbtApexWwwRedirectLocation("www.collproreno.com", "/home") === null,
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
  "Marketing home href is / on www.tbbtool.com and /home elsewhere",
  tbbtMarketingHomeHref("www.tbbtool.com") === "/" &&
    tbbtMarketingHomeHref("localhost") === "/home",
);
check(
  "Canonical URLs always point at https://www.tbbtool.com",
  tbbtCanonicalUrl("/") === "https://www.tbbtool.com/" &&
    tbbtCanonicalUrl("/home") === "https://www.tbbtool.com/" &&
    tbbtCanonicalUrl("/pricing") === "https://www.tbbtool.com/pricing",
);
check(
  "Off-canonical hosts noindex TBBT marketing; www.tbbtool.com indexes",
  tbbtMarketingRobots("localhost").index === false &&
    tbbtMarketingRobots("www.collproreno.com").index === false &&
    tbbtMarketingRobots("tbbtool.com").index === false &&
    tbbtMarketingRobots("www.tbbtool.com").index === true,
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
check(
  "Auth proxy 308s tbbtool.com apex to www before serving any homepage",
  proxySrc.includes("tbbtApexWwwRedirectLocation") &&
    proxySrc.includes("NextResponse.redirect(apexLocation, 308)"),
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
    TBBT_PRICING_FEATURES.some((item) => item.includes("30-day")) &&
    TBBT_HERO_OFFER.includes("No credit card") &&
    TBBT_FOUNDER_NO_CARD.toLowerCase().includes("no credit card") &&
    TBBT_FOUNDER_PROTECTION.includes("continuously active"),
);
check(
  "Primary signup CTAs use Start Free language and /sign-up",
  TBBT_SIGN_UP_HREF === "/sign-up" &&
    TBBT_TRIAL_NAV_LABEL === "Start Free" &&
    TBBT_TRIAL_CTA_LABEL === "Start Free for 30 Days" &&
    TBBT_SEE_WHAT_YOU_GET_LABEL === "See What You Get" &&
    !TBBT_TRIAL_CTA_LABEL.includes("Book Demo") &&
    !TBBT_TRIAL_CTA_LABEL.includes("Buy Now"),
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
    !marketingLibSrc.includes("$29") &&
    pricingSrc.includes("TBBT_FOUNDER_PLAN_DISPLAY_NAME") &&
    pricingSrc.includes("TBBT_SIGN_UP_HREF") &&
    pricingSrc.includes("Starter") &&
    pricingSrc.includes("Business") &&
    pricingSrc.includes("Enterprise") &&
    pricingSrc.includes("Coming Soon") &&
    pricingSrc.includes("TBBT_PRICING_PLANNED_LABEL") &&
    pricingSrc.includes("TBBT_PRICING_AVAILABLE_NOW_LABEL") &&
    pricingSrc.includes("Pricing to be announced") === false &&
    marketingLibSrc.includes("Pricing to be announced") &&
    !pricingSrc.includes("No invented tiers"),
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
    marketingCssSrc.includes("--tbbt-logo-h: 9.8rem") &&
    marketingCssSrc.includes("overflow: visible") &&
    marketingCssSrc.includes("position: absolute"),
);
check(
  "Home keeps BUILD / RUN / GROW and the connected lifecycle",
  homeMarketingSrc.includes("Build. Run. Grow.") &&
    homeMarketingSrc.includes("build-card.png") &&
    homeMarketingSrc.includes("run-card.png") &&
    homeMarketingSrc.includes("grow-card.png") &&
    homeMarketingSrc.includes("TBBT_WORKFLOW_STEPS") &&
    homeMarketingSrc.includes("TBBT_TRIAL_CTA_LABEL") &&
    homeMarketingSrc.includes("tbbt-hero-cinematic") &&
    homeCssSrc.includes("hero-workshop.png") &&
    homeMarketingSrc.includes("hero-tradespro.png") &&
    homeMarketingSrc.includes("tbbt-connected-arrow"),
);
check(
  "Homepage conversion sections cover Founder Plan, How it works, and /sign-up",
  homeMarketingSrc.includes("TBBT_HOW_IT_WORKS") &&
    homeMarketingSrc.includes("id=\"founder-plan\"") &&
    homeMarketingSrc.includes("TBBT_DIFFERENTIATION") &&
    homeMarketingSrc.includes("tbbt-offer-grid") &&
    homeMarketingSrc.includes("TBBT_SEE_WHAT_YOU_GET_LABEL") &&
    homeMarketingSrc.includes("TBBT_SIGN_UP_HREF") &&
    TBBT_HOW_IT_WORKS.length === 4 &&
    TBBT_HOW_IT_WORKS[2].body.includes("public business website") &&
    !homeMarketingSrc.includes("tbbt-os-grid") &&
    !homeMarketingSrc.includes("TBBT_OS_GROUPS") &&
    !homeMarketingSrc.includes("custom domain is automatically") &&
    !homeMarketingSrc.includes("#1") &&
    !homeMarketingSrc.includes("guaranteed") &&
    !homeMarketingSrc.includes("AI-powered everything") &&
    !homeMarketingSrc.includes("testimonial"),
);
check(
  "Privacy and Terms routes exist in the footer and as public pages",
  TBBT_LEGAL_NAV.some((item) => item.href === "/privacy") &&
    TBBT_LEGAL_NAV.some((item) => item.href === "/terms") &&
    readRepo("src/app/(tbbt)/privacy/page.tsx").includes("TbbtPrivacyPage") &&
    readRepo("src/app/(tbbt)/terms/page.tsx").includes("TbbtTermsPage"),
);
check(
  "Homepage trade strip uses dedicated visual thumbnails, not chips",
  marketingLibSrc.includes("trade-handyman.png") &&
    marketingLibSrc.includes("trade-landscaping.png") &&
    marketingLibSrc.includes("trade-more.png") &&
    homeMarketingSrc.includes("tbbt-trade-strip") &&
    !homeMarketingSrc.includes("tbbt-chip"),
);
const tradesPageSrc = readRepo("src/components/tbbt-marketing/trades.tsx");
const tradesCssSrc = readRepo("src/components/tbbt-marketing/tbbt-trades.css");
const featuresPageSrc = readRepo("src/components/tbbt-marketing/features.tsx");
const expectedTradePhotos = {
  Handyman: "trades-page-handyman.png",
  Cleaning: "trades-page-cleaning.png",
  Electrical: "trades-page-electrical.png",
  Plumbing: "trades-page-plumbing.png",
  HVAC: "trades-page-hvac.png",
  Painting: "trades-page-painting.png",
  Landscaping: "trades-page-landscaping.png",
  Roofing: "trades-page-roofing.png",
  Remodeling: "trades-page-remodeling.png",
  Concrete: "trades-page-concrete.png",
  Carpentry: "trades-page-carpentry.png",
};
check(
  "Trades page uses the supplied Task #84 photos, not homepage thumbs or reference crops",
  Object.entries(expectedTradePhotos).every(([name, file]) =>
    TBBT_TRADES_PAGE_CARDS[name]?.src?.endsWith(file),
  ) &&
    TBBT_TRADES_PAGE_HERO_PRO_SRC.endsWith("trades-page-hero.png") &&
    TBBT_TRADES_PAGE_CTA_SRC.endsWith("cta-sunset.png") &&
    TBBT_TRADES_PAGE_PLATFORM_SRC.endsWith("trades-page-platform-devices.png") &&
    !TBBT_TRADES_PAGE_HERO_PRO_SRC.endsWith("hero-tradespro.png") &&
    tradesPageSrc.includes("TBBT_TRADES_PAGE_CARDS") &&
    tradesPageSrc.includes("tbbt-trd-hero") &&
    tradesCssSrc.includes("hero-workshop.png") &&
    tradesCssSrc.includes("object-fit: cover") &&
    !tradesPageSrc.includes("trades-page-promo.png") &&
    !tradesCssSrc.includes("trades-page-promo.png") &&
    !tradesPageSrc.includes("hero-tradespro.png") &&
    !tradesPageSrc.includes("trade-handyman.png") &&
    !tradesPageSrc.includes("Join thousands") &&
    Object.values(expectedTradePhotos).every((file) =>
      existsSync(new URL(`../public/brand/tbbt-marketing/${file}`, import.meta.url)),
    ) &&
    existsSync(new URL("../public/brand/tbbt-marketing/trades-page-hero.png", import.meta.url)) &&
    existsSync(new URL("../public/brand/tbbt-marketing/trades-page-platform-devices.png", import.meta.url)) &&
    existsSync(new URL("../public/brand/tbbt-marketing/trades-page-platform.png", import.meta.url)) &&
    existsSync(new URL("../public/brand/tbbt-marketing/hero-tradespro.png", import.meta.url)) &&
    existsSync(new URL("../public/brand/tbbt-marketing/cta-sunset.png", import.meta.url)),
);
check(
  "Trades page keeps Handyman available, Cleaning next, others planned, And More as roadmap",
  TBBT_TRADES.find((trade) => trade.name === "Handyman")?.status === "available" &&
    TBBT_TRADES.find((trade) => trade.name === "Cleaning")?.status === "coming-next" &&
    TBBT_TRADES.filter((trade) => trade.status === "available").length === 1 &&
    TBBT_TRADES_PAGE_CARDS["And More"]?.badge === TBBT_TRADES_PAGE_ROADMAP_LABEL &&
    !TBBT_TRADES_PAGE_CARDS["And More"]?.src &&
    TBBT_TRADES_PAGE_CTA_HEADLINE === "Ready to Build Your Trade Business?" &&
    TBBT_TRADES_PAGE_CAPABILITIES.includes("Public business website") &&
    TBBT_TRADES_PAGE_CAPABILITIES.includes("Marketing content workspace") &&
    !TBBT_TRADES_PAGE_CAPABILITIES.some((item) => /online booking|payroll|bank/i.test(item)),
);
check(
  "Homepage and Features stay on their own pages during the Trades rebuild",
  homeMarketingSrc.includes("tbbt-hero-cinematic") &&
    homeMarketingSrc.includes("tbbt-trade-strip") &&
    !homeMarketingSrc.includes("trades-page-handyman.png") &&
    featuresPageSrc.includes("tbbt-feat-hero") &&
    !featuresPageSrc.includes("trades-page-platform.png"),
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
  "Features page uses the visual rebuild without unsupported claims or fake Learn More",
  featuresPageSrc.includes("tbbt-feat-hero") &&
    featuresPageSrc.includes("hero-devices.png") &&
    featuresPageSrc.includes("feat-core-website.png") &&
    featuresPageSrc.includes("feat-core-crm.png") &&
    featuresPageSrc.includes("feat-core-schedule.png") &&
    featuresPageSrc.includes("feat-core-estimates.png") &&
    featuresPageSrc.includes("feat-core-jobs.png") &&
    featuresPageSrc.includes("feat-core-invoices.png") &&
    featuresPageSrc.includes("feat-core-time.png") &&
    featuresPageSrc.includes("feat-core-team.png") &&
    featuresPageSrc.includes("feat-core-marketing.png") &&
    featuresPageSrc.includes("feat-core-reports.png") &&
    featuresPageSrc.includes("TBBT_FEATURES_VALUE_POINTS") &&
    featuresPageSrc.includes("TBBT_COMING_FEATURES") &&
    featuresPageSrc.includes("id=\"coming-to-tbbt\"") &&
    featuresPageSrc.includes("TBBT_SIGN_UP_HREF") &&
    featuresPageSrc.includes("TBBT_TRIAL_CTA_LABEL") &&
    featuresPageSrc.includes("id=\"core-features\"") &&
    !featuresPageSrc.includes("Learn More") &&
    !featuresPageSrc.includes("already saving time") &&
    !featuresPageSrc.includes("Join trades professionals"),
);
check(
  "Coming to TBBT is labeled roadmap, not live, with no launch dates",
  TBBT_COMING_FEATURES.length === 7 &&
    TBBT_COMING_FEATURES.some((item) => item.title === "Customer Portal" && item.badge === "coming-soon") &&
    TBBT_COMING_FEATURES.some((item) => item.title === "Multi-Location" && item.badge === "planned") &&
    TBBT_COMING_FEATURES.some((item) => item.title === "Business Success / AI Coaching") &&
    TBBT_COMING_FEATURES.every((item) => item.body.toLowerCase().includes("today") || item.body.toLowerCase().includes("not")) &&
    TBBT_ADDITIONAL_FEATURES.every((item) => item.status === "live") &&
    !TBBT_COMING_FEATURES.some((item) => /\b20\d{2}\b|Q[1-4]|launch date/.test(item.body)),
);
check(
  "Live feature copy keeps Stripe, SMS, and publishing provider-dependent",
  TBBT_CORE_FEATURES.some((item) => item.body.includes("Stripe Connect")) &&
    TBBT_CORE_FEATURES.some((item) => item.body.includes("does not currently publish")) &&
    TBBT_ADDITIONAL_FEATURES.some((item) => item.body.includes("connected number")),
);
check(
  "Homepage from Task #82 is unchanged by the Features rebuild",
  homeMarketingSrc.includes("tbbt-hero-cinematic") &&
    homeMarketingSrc.includes("id=\"founder-plan\"") &&
    homeMarketingSrc.includes("TBBT_HOW_IT_WORKS") &&
    !homeMarketingSrc.includes("tbbt-feat-hero"),
);
check(
  "TBBT production origins are in the R2 browser-upload CORS list",
  r2Src.includes("https://tbbtool.com") &&
    r2Src.includes("https://www.tbbtool.com") &&
    r2Src.includes("https://www.collproreno.com"),
);

const seo = tbbtMarketingMetadata({
  page: "pricing",
  pathname: "/pricing",
  host: "www.collproreno.com",
});
check(
  "Marketing metadata canonicalizes to www.tbbtool.com and noindexes CollPro hosts",
  seo.alternates?.canonical === "https://www.tbbtool.com/pricing" &&
    seo.robots?.index === false,
);
const liveSeo = tbbtMarketingMetadata({
  page: "home",
  pathname: "/",
  host: "www.tbbtool.com",
});
check(
  "www.tbbtool.com homepage metadata is indexable with an absolute title",
  liveSeo.robots?.index === true &&
    liveSeo.alternates?.canonical === "https://www.tbbtool.com/" &&
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
    "Default / is not the TBBT marketing homepage off www.tbbtool.com",
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
        features.body.includes("Coming to TBBT") &&
        features.body.includes("AI Coaching") &&
        features.body.includes("Planned") &&
        features.body.includes("Coming Soon") &&
        features.body.includes("Customer Portal"),
    ),
  );
  const trades = await fetchMaybe("/trades");
  check(
    "Trades page shows supplied photos, honest status, and signup without fake volume claims",
    Boolean(
      trades &&
        trades.body.includes("One Platform") &&
        trades.body.includes("Every Trade") &&
        trades.body.includes("trades-page-handyman.png") &&
        trades.body.includes("trades-page-cleaning.png") &&
        trades.body.includes("trades-page-platform-devices.png") &&
        trades.body.includes("trades-page-hero.png") &&
        !trades.body.includes("hero-tradespro.png") &&
        trades.body.includes("cta-sunset.png") &&
        !trades.body.includes("trades-page-promo.png") &&
        trades.body.includes("Available") &&
        trades.body.includes("Coming Next") &&
        trades.body.includes("Roadmap") &&
        trades.body.includes("/sign-up") &&
        !trades.body.includes("Join thousands"),
    ),
  );
  const pricing = await fetchMaybe("/pricing");
  check(
    "Pricing HTTP page shows $49/month Founder Plan and signup",
    Boolean(
      pricing &&
        pricing.body.includes("$49/month") &&
        pricing.body.includes("/sign-up") &&
        pricing.body.includes("Coming Soon") &&
        pricing.body.includes("Available Now") &&
        pricing.body.includes("Starter") &&
        pricing.body.includes("Business") &&
        pricing.body.includes("Enterprise") &&
        !pricing.body.includes("$29/month") &&
        !pricing.body.includes("$29 /month"),
    ),
  );
  const homePreview = await fetchMaybe("/home");
  check(
    "Preview home uses existing signup, not a duplicate auth system",
    Boolean(
      homePreview &&
        homePreview.body.includes("/sign-up") &&
        homePreview.body.includes("/sign-in") &&
        homePreview.body.includes("Start Free for 30 Days"),
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
