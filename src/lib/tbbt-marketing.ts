/**
 * Copy, navigation, and honest capability inventory for the TBBT
 * corporate marketing site. This is not the CollPro tenant website.
 *
 * Feature claims are limited to capabilities that exist in this
 * application, or are explicitly labeled planned / coming.
 */
import {
  getPricingPageProjection,
  PRICING_ADDON_PRICE_LABEL,
  PRICING_AVAILABLE_NOW_LABEL,
  PRICING_COMING_SOON_LABEL,
  PRICING_COMPARE_ROWS,
  PRICING_PLANNED_LABEL,
} from "@/lib/product-catalog";
import { TBBT_SAAS_PLAN_NAME } from "@/lib/saas-billing/config";
import {
  TBBT_FOUNDER_PLAN_PRICE_LABEL,
  TBBT_FOUNDER_TRIAL_DAYS,
} from "@/lib/saas-billing/founder-price";

export const TBBT_PRODUCT_NAME = "TBBT";
export const TBBT_PRODUCT_LONG_NAME = "Trades Business Builder Tool";
export const TBBT_TAGLINE = "More Than Tools. A Better Way Forward.";
export const TBBT_BRAND_MOTTO = "Build. Run. Grow.";
export const TBBT_POSITIONING =
  "The All-In-One Business Operating System for the Trades.";
export const TBBT_SIGN_IN_HREF = "/sign-in";
export const TBBT_SIGN_UP_HREF = "/sign-up";
export const TBBT_TRIAL_CTA_LABEL = "Start Free for 30 Days";
export const TBBT_TRIAL_NAV_LABEL = "Start Free";
export const TBBT_SEE_WHAT_YOU_GET_HREF = "#what-you-get";
export const TBBT_SEE_WHAT_YOU_GET_LABEL = "See What You Get";

export const TBBT_NAV = [
  { href: "/", label: "Home", key: "home" },
  { href: "/features", label: "Features", key: "features" },
  { href: "/trades", label: "Trades", key: "trades" },
  { href: "/pricing", label: "Pricing", key: "pricing" },
  { href: "/about", label: "About", key: "about" },
  { href: "/resources", label: "Resources", key: "resources" },
] as const;

export const TBBT_LEGAL_NAV = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

export const TBBT_HERO_HEADLINE = [
  "Build your trades",
  "business.",
  "Run it from",
] as const;

export const TBBT_HERO_ACCENT = "one place.";

export const TBBT_HERO_SCRIPT = "Built for the Trades. By a Tradesman.";

export const TBBT_HERO_SUPPORT_LINES = [
  "Website, customers, estimates, jobs, scheduling, invoices — and the tools you need to operate your business.",
] as const;

export const TBBT_HERO_OFFER = "30 days free. No credit card required.";

export const TBBT_HERO_EYEBROW =
  "The operating system for trades and service businesses";

export const TBBT_PROMISE_STRIP = [
  { kicker: "Save Time", body: "Stop jumping between disconnected tools for the same customer." },
  { kicker: "Look Professional", body: "A real website, written estimates, and clean invoices from one system." },
  { kicker: "Get More Customers", body: "Capture leads, follow them through the job, and ask for the next one." },
  { kicker: "Grow Your Business", body: "See the work, the money, and the team — then decide what to do next." },
] as const;

export const TBBT_OPERATING_HELP = [
  "Build their website",
  "Manage customers",
  "Schedule work",
  "Create estimates and quotes",
  "Manage jobs",
  "Invoice customers",
  "Track time",
  "Organize teams",
  "Market the business",
  "Understand performance",
  "Grow",
] as const;

export type TbbtTradeAvailability = "available" | "coming-next" | "planned";

export type TbbtTradeThumb = {
  src: string;
  position?: string;
};

/** Temporary photography for the homepage trade strip. Replace in place. */
export const TBBT_TRADE_THUMBS: Record<string, TbbtTradeThumb> = {
  Handyman: { src: "/brand/tbbt-marketing/trade-handyman.png" },
  Cleaning: { src: "/brand/tbbt-marketing/trade-cleaning.png" },
  Electrical: { src: "/brand/tbbt-marketing/trade-electrical.png" },
  Plumbing: { src: "/brand/tbbt-marketing/trade-plumbing.png" },
  HVAC: { src: "/brand/tbbt-marketing/trade-hvac.png" },
  Painting: { src: "/brand/tbbt-marketing/trade-painting.png" },
  Landscaping: { src: "/brand/tbbt-marketing/trade-landscaping.png" },
  Roofing: { src: "/brand/tbbt-marketing/trade-roofing.png" },
  Remodeling: { src: "/brand/tbbt-marketing/trade-remodeling.png" },
  Concrete: { src: "/brand/tbbt-marketing/trade-concrete.png" },
  Carpentry: { src: "/brand/tbbt-marketing/trade-carpentry.png" },
  "And More": { src: "/brand/tbbt-marketing/trade-more.png" },
};

export const TBBT_TRADES: readonly {
  name: string;
  status: TbbtTradeAvailability;
  summary: string;
}[] = [
  {
    name: "Handyman",
    status: "available",
    summary: "First live trade template. New workspaces start here today.",
  },
  {
    name: "Cleaning",
    status: "planned",
    summary: "Planned trade template. Architecture remains in Core; development is on hold until TBBT Core is fully operational.",
  },
  {
    name: "Electrical",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Plumbing",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "HVAC",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Painting",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Landscaping",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Roofing",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Remodeling",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Concrete",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "Carpentry",
    status: "planned",
    summary: "Planned trade template. Not available to launch today.",
  },
  {
    name: "And More",
    status: "planned",
    summary: "The architecture is built for many trades over time. Additional trades are not live.",
  },
];

export const TBBT_TRADE_STATUS_LABEL: Record<TbbtTradeAvailability, string> = {
  available: "Available",
  "coming-next": "Planned",
  planned: "Planned",
};

export const TBBT_TRADES_PAGE_ROADMAP_LABEL = "Roadmap";

export const TBBT_TRADES_PAGE_EYEBROW = "Built for the Trades";
export const TBBT_TRADES_PAGE_HEADLINE = ["One Platform.", "Every Trade."] as const;
export const TBBT_TRADES_PAGE_SUPPORT =
  "TBBT gives trades businesses one place to build their presence, manage customers and work, and grow the business.";
export const TBBT_TRADES_PAGE_SIDE_LINE = "Different Trades. Same Powerful Platform.";

export const TBBT_TRADES_PAGE_VALUE_POINTS = [
  {
    kicker: "Trade-Specific Setup",
    body: "Start from the live Handyman setup. More trades follow on the same platform.",
  },
  {
    kicker: "Industry Best Practices",
    body: "Workflows follow how trades work actually moves.",
  },
  {
    kicker: "Grows With You",
    body: "Start simple. Add more of the workspace as the business expands.",
  },
] as const;

export const TBBT_TRADES_PAGE_GRID_HEADING = "Supported Trades";
export const TBBT_TRADES_PAGE_GRID_LEAD =
  "Handyman is live today. Additional trades are planned on the roadmap after the core platform is completed.";

export const TBBT_TRADES_PAGE_PLATFORM_KICKER = "One Platform. Endless Possibilities.";
export const TBBT_TRADES_PAGE_PLATFORM_HEADLINE = [
  "All the Tools You Need",
  "For Your Trade.",
] as const;
export const TBBT_TRADES_PAGE_PLATFORM_SUPPORT =
  "Every trade uses the same TBBT workspace. Handyman is live today — public website, catalog, customers, scheduling, estimates, jobs, invoices, and the rest of the operating tools. Additional trade setups are planned after the core platform is completed.";
export const TBBT_TRADES_PAGE_SEE_FEATURES_LABEL = "See All Features";

export const TBBT_TRADES_PAGE_CAPABILITIES = [
  "Public business website",
  "Service catalog and pricing",
  "Customer request intake",
  "Customers / CRM",
  "Scheduling",
  "Estimates",
  "Jobs",
  "Invoices",
  "Expenses",
  "Time cards",
  "Team management",
  "Reviews workflow",
  "Marketing content workspace",
  "Reports and business insights",
] as const;

export const TBBT_TRADES_PAGE_CTA_HEADLINE = "Ready to Build Your Trade Business?";

export const TBBT_TRADES_PAGE_HERO_PRO_SRC = "/brand/tbbt-marketing/trades-page-hero.png";
export const TBBT_TRADES_PAGE_PLATFORM_SRC = "/brand/tbbt-marketing/trades-page-platform-devices.png";
export const TBBT_TRADES_PAGE_CTA_SRC = "/brand/tbbt-marketing/cta-sunset.png";

export type TbbtTradesPageCard = {
  src?: string;
  position?: string;
  summary: string;
  badge?: string;
};

/** Individual supplied Task #84 photos. Homepage still uses TBBT_TRADE_THUMBS. */
export const TBBT_TRADES_PAGE_CARDS: Record<string, TbbtTradesPageCard> = {
  Handyman: {
    src: "/brand/tbbt-marketing/trades-page-handyman.png",
    position: "18% 50%",
    summary: "General repairs, maintenance and home services.",
  },
  Cleaning: {
    src: "/brand/tbbt-marketing/trades-page-cleaning.png",
    position: "38% 50%",
    summary: "Residential and commercial cleaning services.",
  },
  Electrical: {
    src: "/brand/tbbt-marketing/trades-page-electrical.png",
    position: "42% 50%",
    summary: "Installations, repairs and electrical services.",
  },
  Plumbing: {
    src: "/brand/tbbt-marketing/trades-page-plumbing.png",
    position: "58% 50%",
    summary: "Installations, repairs and plumbing services.",
  },
  HVAC: {
    src: "/brand/tbbt-marketing/trades-page-hvac.png",
    position: "82% 50%",
    summary: "Heating, cooling and air quality services.",
  },
  Painting: {
    src: "/brand/tbbt-marketing/trades-page-painting.png",
    position: "48% 50%",
    summary: "Interior and exterior painting services.",
  },
  Landscaping: {
    src: "/brand/tbbt-marketing/trades-page-landscaping.png",
    position: "36% 50%",
    summary: "Lawn care, maintenance and outdoor services.",
  },
  Roofing: {
    src: "/brand/tbbt-marketing/trades-page-roofing.png",
    position: "50% 42%",
    summary: "Roof repair, replacement and maintenance.",
  },
  Remodeling: {
    src: "/brand/tbbt-marketing/trades-page-remodeling.png",
    position: "40% 50%",
    summary: "Kitchens, bathrooms and home renovations.",
  },
  Concrete: {
    src: "/brand/tbbt-marketing/trades-page-concrete.png",
    position: "52% 50%",
    summary: "Driveways, patios, foundations and concrete work.",
  },
  Carpentry: {
    src: "/brand/tbbt-marketing/trades-page-carpentry.png",
    position: "36% 50%",
    summary: "Custom builds, framing and finish work.",
  },
  "And More": {
    summary: "New trades added regularly. Additional trades are not live today.",
    badge: TBBT_TRADES_PAGE_ROADMAP_LABEL,
  },
};

export const TBBT_PILLARS = [
  {
    kicker: "Build",
    title: "A Professional Website for Your Business",
    body: "Stand up a public site with services, service areas, photos, reviews, and lead capture so customers can request work before you ever pick up the phone.",
    points: [
      "Professional design",
      "Your services & areas",
      "Online request form",
      "Mobile optimized",
      "Built for conversions",
    ],
  },
  {
    kicker: "Run",
    title: "Manage Your Day With Ease",
    body: "The same customer who requested work on the website becomes a record you can estimate, schedule, job, invoice, and pay — without rebuilding the story in another app.",
    points: [
      "Online booking",
      "Scheduling & calendar",
      "Estimates & invoices",
      "Time tracking",
      "Team management",
    ],
  },
  {
    kicker: "Grow",
    title: "A Business Partner That Works for You",
    body: "Use what the business already recorded — jobs, invoices, time, and reviews — to see performance and prepare marketing. Software should reduce owner stress and create freedom, not become another job.",
    points: [
      "Business reporting",
      "Track performance",
      "Find growth opportunities",
      "AI business coach (Planned)",
      "Grow with confidence",
    ],
  },
] as const;

export const TBBT_WORKFLOW_STEPS = [
  "Lead",
  "Customer",
  "Estimate",
  "Schedule",
  "Job",
  "Invoice",
  "Payment",
  "Happy Customer",
  "Repeat Business",
] as const;

export const TBBT_CORE_FEATURES = [
  {
    id: "website-builder",
    title: "Website Builder",
    body: "Set up the public business website: services, service area, photos, about copy, and a request path that creates a real lead.",
    href: "/features#website-builder",
    status: "live" as const,
    visual: "website" as const,
  },
  {
    id: "leads-crm",
    title: "Leads & CRM",
    body: "Public requests become customers and pipeline records you can work — not a disconnected inbox.",
    href: "/features#leads-crm",
    status: "live" as const,
    visual: "crm" as const,
  },
  {
    id: "scheduling",
    title: "Scheduling",
    body: "Put approved work on the calendar, see today's jobs, and keep the field and office on the same schedule.",
    href: "/features#scheduling",
    status: "live" as const,
    visual: "schedule" as const,
  },
  {
    id: "estimates",
    title: "Estimates & Quotes",
    body: "Build written estimates from catalog work, send them for approval, and turn approved scope into a job.",
    href: "/features#estimates",
    status: "live" as const,
    visual: "estimate" as const,
  },
  {
    id: "jobs",
    title: "Jobs & Task Management",
    body: "Run the job after the estimate is approved: status, photos, additional work, and completion into invoicing.",
    href: "/features#jobs",
    status: "live" as const,
    visual: "jobs" as const,
  },
  {
    id: "invoices",
    title: "Invoices & Payments",
    body: "Invoice from completed work. Collect customer card payments when Stripe Connect is configured for that business.",
    href: "/features#invoices",
    status: "live" as const,
    visual: "invoice" as const,
  },
  {
    id: "time-tracking",
    title: "Time Tracking",
    body: "Time cards for the people doing the work, with payroll support from recorded hours — not guessed totals.",
    href: "/features#time-tracking",
    status: "live" as const,
    visual: "time" as const,
  },
  {
    id: "team",
    title: "Team Management",
    body: "Invite team members, assign roles, and keep field access separate from owner/admin work.",
    href: "/features#team",
    status: "live" as const,
    visual: "team" as const,
  },
  {
    id: "marketing",
    title: "Marketing Tools",
    body: "Prepare content from completed jobs and approved photos. Social channels are intent/draft only — TBBT does not currently publish posts for you.",
    href: "/features#marketing",
    status: "live" as const,
    visual: "marketing" as const,
  },
  {
    id: "reports",
    title: "Reports & Business Insights",
    body: "Reports over invoices, jobs, customers, time, and expenses recorded in TBBT. This is not a full accounting suite.",
    href: "/features#reports",
    status: "live" as const,
    visual: "reports" as const,
  },
] as const;

export const TBBT_FEATURES_HERO_EYEBROW = "Features";
export const TBBT_FEATURES_HERO_HEADLINE = [
  "Everything You Need",
  "to Run Your Trades Business.",
] as const;
export const TBBT_FEATURES_HERO_SUPPORT =
  "TBBT brings the main operating tools of a trades business into one workspace: website, customers, estimates, jobs, scheduling, invoices, time, and the records you need to run the day.";

export const TBBT_FEATURES_VALUE_POINTS = [
  { kicker: "Save Time", body: "Stop jumping between disconnected tools for the same customer." },
  { kicker: "Look Professional", body: "A public website, written estimates, and invoices from one system." },
  { kicker: "Run the Business", body: "Customers, schedule, jobs, time, and money stay in one workspace." },
  { kicker: "Built for the Trades", body: "Workflows follow how the work actually moves: request, estimate, job, invoice." },
] as const;

export const TBBT_ADDITIONAL_FEATURES = [
  {
    title: "Service Catalog",
    body: "Start from TBBT's Handyman catalog and customize the work you sell.",
    status: "live" as const,
  },
  {
    title: "Website Photos",
    body: "Add business and job photos to the public website.",
    status: "live" as const,
  },
  {
    title: "Website Story",
    body: "About copy and service-area pages for the public site.",
    status: "live" as const,
  },
  {
    title: "Customer Request Intake",
    body: "A public request path that creates a real lead in the workspace.",
    status: "live" as const,
  },
  {
    title: "Business Settings",
    body: "Business profile, team, and operating preferences.",
    status: "live" as const,
  },
  {
    title: "Pricing Rules",
    body: "Catalog prices and business-wide pricing rules for new work. They do not rewrite sent estimates.",
    status: "live" as const,
  },
  {
    title: "Expenses",
    body: "Record job and business expenses inside the workspace.",
    status: "live" as const,
  },
  {
    title: "Reviews Workflow",
    body: "Record customer reviews and draft responses. TBBT does not invent testimonials or post them for you.",
    status: "live" as const,
  },
  {
    title: "Knowledge Hub",
    body: "Owner-recorded operating knowledge. There is no AI writer in production.",
    status: "live" as const,
  },
  {
    title: "Material takeoff helpers",
    body: "Takeoff worksheets for scoped estimate lines. They do not invent production rates.",
    status: "live" as const,
  },
  {
    title: "Customer communications",
    body: "Messaging foundation for customer follow-up. SMS sends only when that business has a connected number.",
    status: "live" as const,
  },
] as const;

export const TBBT_COMING_FEATURES = [
  {
    title: "Customer Portal",
    body: "A customer-facing place to review estimates, jobs, and invoices. Not in the workspace today.",
    badge: "coming-soon" as const,
  },
  {
    title: "Multi-Location",
    body: "Support for businesses that operate more than one location. One workspace per business today.",
    badge: "planned" as const,
  },
  {
    title: "Local Service / SEO Pages",
    body: "More local service pages to help customers find the business. Not a live SEO product today.",
    badge: "planned" as const,
  },
  {
    title: "Expanded Integrations",
    body: "More connections over time. Stripe, SMS, banking, and payroll are not automatic — they still have to be set up per business.",
    badge: "planned" as const,
  },
  {
    title: "Deeper Marketing Automation",
    body: "More follow-up after the current marketing content workspace. TBBT does not currently publish posts for you.",
    badge: "planned" as const,
  },
  {
    title: "Expanded Data Export",
    body: "Richer export of workspace records over time. Not a full accounting or payroll export suite today.",
    badge: "planned" as const,
  },
  {
    title: "Business Success / AI Coaching",
    body: "Direction for later coaching inside TBBT. Not a production feature today.",
    badge: "planned" as const,
  },
] as const;

export const TBBT_COMING_BADGE_LABEL = {
  "coming-soon": "Coming Soon",
  planned: "Planned",
} as const;

export const TBBT_FOUNDER_PRICE_LABEL = TBBT_FOUNDER_PLAN_PRICE_LABEL;
export const TBBT_FOUNDER_PLAN_DISPLAY_NAME = TBBT_SAAS_PLAN_NAME;
export const TBBT_FOUNDER_TRIAL_LABEL = `${TBBT_FOUNDER_TRIAL_DAYS}-Day Free Trial`;
export const TBBT_FOUNDER_NO_CARD = "No credit card required.";
export const TBBT_FOUNDER_PROTECTION =
  "Founder pricing stays protected while your subscription remains continuously active.";

export const TBBT_HOW_IT_WORKS = [
  {
    step: "1",
    title: "Create your business",
    body: "Enter your business information.",
  },
  {
    step: "2",
    title: "Choose your services",
    body: "Start with TBBT's Handyman service catalog and customize it.",
  },
  {
    step: "3",
    title: "Get your website",
    body: "TBBT creates your public business website and request-service path.",
  },
  {
    step: "4",
    title: "Run the work",
    body: "Manage customers, estimates, jobs, scheduling, invoices, expenses and time.",
  },
] as const;

export const TBBT_OS_GROUPS = [
  {
    kicker: "Get online",
    title: "Show up as a real business",
    points: [
      "Public business website",
      "Services customers can request",
      "Customer request intake",
    ],
  },
  {
    kicker: "Run the business",
    title: "Operate from one workspace",
    points: [
      "Customers and CRM",
      "Estimates, jobs, and scheduling",
      "Invoices, expenses, time cards, and reporting",
    ],
  },
  {
    kicker: "Grow",
    title: "Use the work you already recorded",
    points: [
      "Reviews workflow",
      "Marketing content workspace",
      "Customer follow-up foundation",
    ],
  },
] as const;

export const TBBT_DIFFERENTIATION = {
  title: "One workspace instead of a pile of tools",
  body: "Most small tradespeople end up piecing together a website, scheduling, customer records, estimates, invoices, time tracking, job records, and marketing. TBBT brings those operating pieces into one business workspace.",
} as const;

export const TBBT_HOMEPAGE_PRICING_POINTS = [
  "Public website and request-service path",
  "Customers, estimates, jobs, and scheduling",
  "Invoices, expenses, time cards, and reporting",
  "Reviews and marketing content workspace",
] as const;

export const TBBT_PRICING_FEATURES = [
  "Public website setup with the Handyman trade template",
  "Lead capture, customers, and pipeline",
  "Estimates, jobs, and scheduling",
  "Invoices and customer payment collection (Stripe Connect when the business is ready)",
  "Time cards, team, and roles",
  "Expenses, reports, reviews, and marketing content workspace",
  "Knowledge hub for how your business actually runs",
  `${TBBT_FOUNDER_TRIAL_DAYS}-day free trial — no credit card required to begin`,
  "Founder rate protected while you stay continuously subscribed",
] as const;

export const TBBT_PRICING_PAGE_EYEBROW = "Simple. Transparent. Built for Trades.";
export const TBBT_PRICING_PAGE_HEADLINE = ["Plans That Grow", "With Your Business."] as const;
export const TBBT_PRICING_PAGE_SUPPORT = [
  "Everything you need to build, run and grow your trades business.",
  "One platform. No hidden fees. Cancel anytime.",
] as const;
export const TBBT_PRICING_PAGE_SCRIPT = "Invest in a Better Tomorrow.";
export const TBBT_PRICING_PAGE_HERO_SRC = "/brand/tbbt-marketing/pricing-page-hero.png";
export const TBBT_PRICING_PAGE_CTA_SRC = "/brand/tbbt-marketing/cta-sunset.png";
export const TBBT_PRICING_PAGE_CTA_HEADLINE = "Ready to Build a Better Business?";
export const TBBT_PRICING_PAGE_CTA_SUPPORT =
  "Take control of your trades business with TBBT. Start free today and see the difference.";
export const TBBT_PRICING_PAGE_CTA_BUTTON = "Start Your Free 30-Day Trial";
export const TBBT_PRICING_PAGE_FOUNDER_CTA = "Start Free Trial";

export const TBBT_PRICING_PAGE_VALUE_POINTS = [
  { kicker: "Get Started", body: "In Minutes" },
  { kicker: "All Core Tools", body: "Included" },
  { kicker: "No Long-Term", body: "Contracts" },
  { kicker: "Real Support", body: "From Real People" },
] as const;

export const TBBT_PRICING_PAGE_HERO_CHECKS = [
  "Built for the Trades",
  "All the Tools You Need",
  "Built for Real Work",
  "Affordable & Scalable",
] as const;

export const TBBT_PRICING_PAGE_INTRO = {
  heading: ["Choose the Plan", "That Fits Your Business"] as const,
  body: "All plans include the core tools you need to run a professional trades business. Upgrade or add tools as you grow.",
  compare: "Compare Plans",
  compareLead: "See what's included in each plan.",
} as const;

const pricingPageProjection = getPricingPageProjection();

export const TBBT_PRICING_COMING_SOON_LABEL = PRICING_COMING_SOON_LABEL;
export const TBBT_PRICING_PLANNED_LABEL = PRICING_PLANNED_LABEL;
export const TBBT_PRICING_AVAILABLE_NOW_LABEL = PRICING_AVAILABLE_NOW_LABEL;

/** Truthful current Founder capabilities shown on the live plan card. */
export const TBBT_PRICING_FOUNDER_CARD_FEATURES = pricingPageProjection.founderCardFeatures;

export const TBBT_PRICING_STARTER_CARD_FEATURES = pricingPageProjection.starterCardFeatures;

export const TBBT_PRICING_BUSINESS_CARD_FEATURES = pricingPageProjection.businessCardFeatures;

export const TBBT_PRICING_ENTERPRISE_CARD_FEATURES = pricingPageProjection.enterpriseCardFeatures;

export const TBBT_PRICING_COMPARE_ROWS = PRICING_COMPARE_ROWS.map((row) => ({
  label: row.label,
  values: row.values,
}));

export const TBBT_PRICING_ADDONS = pricingPageProjection.addons.map((addon) => ({
  title: addon.title,
  icon: addon.icon,
}));

export const TBBT_PRICING_ADDON_STATUS = PRICING_COMING_SOON_LABEL;
export const TBBT_PRICING_ADDON_PRICE = PRICING_ADDON_PRICE_LABEL;

export const TBBT_PRICING_TRUST = [
  {
    title: "30-Day Free Trial",
    body: "Try TBBT risk-free for 30 days. No credit card required. Cancel anytime.",
    icon: "shield",
  },
  {
    title: "Fair & Transparent",
    body: "Simple pricing. No hidden fees. Upgrade, downgrade or cancel anytime.",
    icon: "handshake",
  },
  {
    title: "Real Human Support",
    body: "Get help from a real person who understands the trades.",
    icon: "headset",
  },
] as const;

export const TBBT_VALUES = [
  {
    title: "Simplicity",
    body: "The product should make the day clearer, not add another system to babysit.",
  },
  {
    title: "Built for Trades",
    body: "Workflows follow how trades work actually moves: request, estimate, job, invoice, repeat.",
  },
  {
    title: "Fair & Transparent",
    body: "One launch plan. No hidden add-on ladder. What is live is labeled live; what is coming is labeled coming.",
  },
  {
    title: "Growth",
    body: "The same records that run the day should help the owner see what to do next.",
  },
  {
    title: "Support",
    body: "Software is a partner. It should reduce owner stress and create freedom.",
  },
  {
    title: "Continuous Improvement",
    body: "Handyman is first. Additional trades are planned after TBBT Core is fully operational. The operating system is built to add trades without starting over.",
  },
] as const;

export const TBBT_ABOUT_PAGE_EYEBROW = "Our Story";
export const TBBT_ABOUT_PAGE_HEADLINE = ["Built by a Tradesman.", "For the Trades."] as const;
export const TBBT_ABOUT_PAGE_SUPPORT =
  "TBBT was created by a third-generation carpenter who understands the real challenges trades professionals face — because he's lived them. After years in the field, running crews, managing jobs and dealing with multiple disconnected tools, the solution was clear: trades need one simple, powerful platform built specifically for them.";
export const TBBT_ABOUT_PAGE_SCRIPT = [
  "Real Experience.",
  "Real Solutions.",
  "A Better Future",
  "for the Trades.",
] as const;
export const TBBT_ABOUT_PAGE_MISSION_CTA = "Our Mission";
export const TBBT_ABOUT_PAGE_WATCH_STORY_LABEL = "Watch Our Story";
export const TBBT_ABOUT_PAGE_HERO_SRC = "/brand/tbbt-marketing/about-page-hero.png";
export const TBBT_ABOUT_PAGE_MISSION_SRC = "/brand/tbbt-marketing/about-page-mission.png";
export const TBBT_ABOUT_PAGE_FOUNDER_SRC = "/brand/tbbt-marketing/about-page-founder.png";
export const TBBT_ABOUT_PAGE_CTA_SRC = "/brand/tbbt-marketing/cta-sunset.png";

export const TBBT_ABOUT_VALUES_INTRO = {
  heading: "Our Values",
  body: "The principles that guide everything we do.",
} as const;

export const TBBT_ABOUT_VALUES = [
  { title: "Simplicity", body: "Easy to use.\nNo tech headaches.", icon: "simplicity" },
  { title: "Built for Trades", body: "Designed for real\nworld needs.", icon: "trades" },
  { title: "Fair & Transparent", body: "Honest pricing.\nNo hidden fees.", icon: "fair" },
  { title: "Growth", body: "Help trades businesses\nwin more work.", icon: "growth" },
  { title: "Support", body: "Real people.\nReal help.", icon: "support" },
  { title: "Continuous Improvement", body: "Always listening.\nAlways getting better.", icon: "improve" },
] as const;

export const TBBT_ABOUT_MISSION = {
  heading: "Our Mission",
  body: "To empower trades professionals with the tools, technology and support they need to build stronger businesses, create more freedom, and take control of their future.",
} as const;

export const TBBT_ABOUT_VISION = {
  heading: "Our Vision",
  body: "To become the leading business operating system for the trades — helping contractors, service professionals and trade businesses around the world run smarter, work more efficiently, and achieve the freedom they deserve.",
} as const;

export const TBBT_ABOUT_DIRECTION = [
  { kicker: "1 Platform", body: "Built for the Trades", icon: "platform" },
  { kicker: "Expanding Support", body: "More trades on the roadmap", icon: "trades" },
  { kicker: "Built to Serve", body: "Trades businesses we aim to support", icon: "serve" },
  { kicker: "Real World Experience", body: "Built by a Tradesman", icon: "experience" },
  { kicker: "A Stronger Future", body: "For the Trades", icon: "future" },
] as const;

export const TBBT_ABOUT_FOUNDER_HEADING = "Meet the Founder";
export const TBBT_ABOUT_FOUNDER_NAME = "Daniel LeBlanc";
export const TBBT_ABOUT_FOUNDER_ROLE = "Founder, TBBT";
export const TBBT_ABOUT_FOUNDER_BIO =
  "Third-generation carpenter, business owner, and builder at heart. TBBT is being built from real field and trades-business experience — not as a generic software experiment. The goal is to help other trades business owners run a simpler, more professional operation and take back time, freedom, and control.";
export const TBBT_ABOUT_FOUNDER_QUOTE =
  "I built TBBT because I know what it's like in the field. Trades deserve better tools, better support, and a better future.";

export const TBBT_ABOUT_PAGE_CTA_HEADLINE = "Let's Build a Better Future for the Trades.";
export const TBBT_ABOUT_PAGE_CTA_SUPPORT =
  "Take control of your trades business with TBBT. Start free today and see the difference.";
export const TBBT_ABOUT_PAGE_CTA_BUTTON = "Start Your Free 30-Day Trial";

export const TBBT_RESOURCES_PAGE_EYEBROW = "Resources";
export const TBBT_RESOURCES_PAGE_HEADLINE = ["Tools, Guides and", "Knowledge"] as const;
export const TBBT_RESOURCES_PAGE_HEADLINE_ACCENT = "for the Trades.";
export const TBBT_RESOURCES_PAGE_SUPPORT = [
  "Practical resources to help you start, run and grow your trades business.",
  "Tips, templates, checklists and expert guidance — all in one place.",
] as const;
export const TBBT_RESOURCES_PAGE_SCRIPT = [
  "Knowledge",
  "Builds",
  "Better",
  "Businesses.",
] as const;
export const TBBT_RESOURCES_PAGE_HERO_SRC = "/brand/tbbt-marketing/resources-page-hero.png";
export const TBBT_RESOURCES_PAGE_CTA_SRC = "/brand/tbbt-marketing/resources-page-cta.png";
export const TBBT_RESOURCES_PAGE_CTA_HEADLINE = "Keep Learning. Keep Growing.";
export const TBBT_RESOURCES_PAGE_CTA_SUPPORT =
  "New resources are added regularly to help you get the most out of TBBT and grow your business.";
export const TBBT_RESOURCES_PAGE_CTA_BUTTON = "Start Free Trial";
export const TBBT_RESOURCES_PAGE_WATCH_LABEL = "Watch Overview";
export const TBBT_RESOURCES_FEATURED_HEADING = "Featured Resources";
export const TBBT_RESOURCES_FEATURED_LEAD =
  "Start with our most popular guides, templates and tools.";
export const TBBT_RESOURCES_FEATURED_VIEW_ALL = "View All Resources";
export const TBBT_RESOURCES_BROWSE_HEADING = "Browse by Category";
export const TBBT_RESOURCES_BROWSE_LEAD = "Find the resources you need, faster.";
export const TBBT_RESOURCES_DOWNLOADS_HEADING = "Popular Downloads";
export const TBBT_RESOURCES_FAQ_HEADING = "FAQs";
export const TBBT_RESOURCES_FAQ_LEAD = "Quick answers to common questions.";
export const TBBT_RESOURCES_FAQ_VIEW_ALL = "View All FAQs";

export const TBBT_RESOURCES_VALUE_POINTS = [
  { title: "Learn at Your Pace", icon: "learn" },
  { title: "Real-World Tools & Templates", icon: "tools" },
  { title: "Built for Trades Professionals", icon: "trades" },
  { title: "Grow a Stronger Business", icon: "grow" },
] as const;

export const TBBT_RESOURCES_FEATURED = [
  {
    key: "guide",
    title: "How to Price Your Handyman Services",
    body: "A practical guide to setting profitable, competitive prices for common handyman jobs.",
    action: "Read Guide",
    src: "/brand/tbbt-marketing/resources-page-guide.png",
    alt: "Suburban house used as the guide card photograph",
  },
  {
    key: "template",
    title: "Free Estimate Template",
    body: "Use our professional estimate template to win more jobs and look professional.",
    action: "Download Template",
    src: "/brand/tbbt-marketing/resources-page-template.png",
    alt: "Estimate template document used as the template card photograph",
  },
  {
    key: "checklist",
    title: "Job Site Checklist",
    body: "Stay organized and professional with our field-ready checklist.",
    action: "Get Checklist",
    src: "/brand/tbbt-marketing/resources-page-checklist.png",
    alt: "Job site checklist clipboard used as the checklist card photograph",
  },
  {
    key: "video",
    title: "Getting Started with TBBT",
    body: "Watch a quick overview of how TBBT helps you build, run and grow your trades business.",
    action: "Watch Video",
    src: "/brand/tbbt-marketing/resources-page-video.png",
    alt: "Tradesman in a TBBT cap used as the video card photograph",
  },
  {
    key: "article",
    title: "Common Materials & Cost Guide",
    body: "A helpful reference for common materials, average costs, and project planning tips.",
    action: "Read Article",
    src: "/brand/tbbt-marketing/resources-page-article.png",
    alt: "Tape measure on a blueprint used as the article card photograph",
  },
] as const;

export const TBBT_RESOURCE_CATEGORIES = [
  { title: "Business Setup Guides", icon: "setup" },
  { title: "Pricing & Estimating", icon: "pricing" },
  { title: "Marketing & Growth", icon: "marketing" },
  { title: "Templates & Forms", icon: "templates" },
  { title: "Operations & Scheduling", icon: "operations" },
  { title: "Industry Insights", icon: "insights" },
] as const;

export const TBBT_RESOURCES_DOWNLOADS = [
  { title: "Estimate Template", format: "PDF" },
  { title: "Job Site Checklist", format: "PDF" },
  { title: "Client Intake Form", format: "PDF" },
  { title: "Time Card Template", format: "Excel" },
  { title: "Service Price List", format: "Excel" },
] as const;

export const TBBT_RESOURCES_FAQS = [
  "How does TBBT work?",
  "Can I use it for multiple trades?",
  "Is there a contract?",
  "Can I cancel anytime?",
  "Do you offer support?",
] as const;

/**
 * Replaceable photography under public/brand/tbbt-marketing/.
 * Temporary originals are shipped so the homepage is not empty.
 * Swap files in place; keep these names and aspect ratios.
 */
export const TBBT_MARKETING_ASSET_SLOTS = [
  {
    file: "hero-workshop.png",
    ratio: "16 / 9",
    pixelHint: "1920 × 1080",
    usage: "Full-bleed cinematic workshop background behind the homepage hero.",
  },
  {
    file: "hero-tradespro.png",
    ratio: "3 / 4",
    pixelHint: "1200 × 1600",
    usage: "Hero trades professional overlapping the product devices. Do not let this become the only brand identity.",
  },
  {
    file: "cta-sunset.png",
    ratio: "16 / 9",
    pixelHint: "1920 × 1080",
    usage: "Lower CTA band. Person from behind at golden hour.",
  },
  {
    file: "build-house.png",
    ratio: "16 / 9",
    pixelHint: "1600 × 900",
    usage: "House photo inside the BUILD website laptop mock.",
  },
  {
    file: "trades-mosaic.png",
    ratio: "16 / 9",
    pixelHint: "1920 × 1080",
    usage: "Optional multi-trade mosaic. Individual trade thumbs are preferred.",
  },
  {
    file: "trade-handyman.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "Handyman trade thumbnail.",
  },
  {
    file: "trade-cleaning.png",
    ratio: "1 / 1",
    pixelHint: "1200 × 1200",
    usage: "Cleaning trade thumbnail.",
  },
  {
    file: "trade-electrical.png",
    ratio: "1 / 1",
    pixelHint: "1200 × 1200",
    usage: "Electrical trade thumbnail.",
  },
  {
    file: "trade-plumbing.png",
    ratio: "1 / 1",
    pixelHint: "1200 × 1200",
    usage: "Plumbing trade thumbnail.",
  },
  {
    file: "trade-hvac.png",
    ratio: "1 / 1",
    pixelHint: "1200 × 1200",
    usage: "HVAC trade thumbnail.",
  },
  {
    file: "trade-painting.png",
    ratio: "1 / 1",
    pixelHint: "1200 × 1200",
    usage: "Painting trade thumbnail.",
  },
  {
    file: "trade-landscaping.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "Landscaping trade thumbnail.",
  },
  {
    file: "trade-roofing.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "Roofing trade thumbnail.",
  },
  {
    file: "trade-remodeling.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "Remodeling trade thumbnail.",
  },
  {
    file: "trade-concrete.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "Concrete trade thumbnail.",
  },
  {
    file: "trade-carpentry.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "Carpentry trade thumbnail.",
  },
  {
    file: "trade-more.png",
    ratio: "4 / 3",
    pixelHint: "1600 × 1200",
    usage: "And More trade thumbnail.",
  },
  {
    file: "grow-coach.png",
    ratio: "1 / 1",
    pixelHint: "800 × 800",
    usage: "GROW coaching portrait inside the homepage mock. Feature is Planned.",
  },
  {
    file: "trades-page-handyman.png",
    ratio: "21 / 9",
    pixelHint: "1938 × 812",
    usage: "Task #84 /trades Handyman card. Do not reuse on Homepage.",
  },
  {
    file: "trades-page-hero.png",
    ratio: "16 / 9",
    pixelHint: "535 × 288",
    usage: "Task #84 /trades hero: back-facing tradesman in TBBT shirt from the supplied master.",
  },
  {
    file: "trades-page-platform.png",
    ratio: "3 / 1",
    pixelHint: "2000 × 667",
    usage: "Supplied Task #84 platform banner. Source only — page displays the devices crop.",
  },
  {
    file: "trades-page-platform-devices.png",
    ratio: "918 / 667",
    pixelHint: "918 × 667",
    usage: "Task #84 /trades center visual: laptop + phone crop from the supplied platform banner.",
  },
  {
    file: "trades-page-promo.png",
    ratio: "21 / 9",
    pixelHint: "1938 × 812",
    usage: "Supplied painting photograph. Not used as hero/CTA. Trade photos stay on their cards.",
  },
  {
    file: "pricing-page-hero.png",
    ratio: "267 / 298",
    pixelHint: "267 × 298",
    usage: "Pricing hero: back-facing tradesman in TBBT BUILD / MANAGE / GROW shirt.",
  },
  {
    file: "about-page-hero.png",
    ratio: "141 / 100",
    pixelHint: "846 × 600",
    usage: "About hero: back-facing tradesman in TBBT BUILD / MANAGE / GROW shirt from the supplied master.",
  },
  {
    file: "about-page-mission.png",
    ratio: "98 / 90",
    pixelHint: "392 × 360",
    usage: "About mission panel: house blueprint crop. Tagline is HTML, not baked into the image.",
  },
  {
    file: "about-page-founder.png",
    ratio: "412 / 233",
    pixelHint: "412 × 233",
    usage: "Daniel LeBlanc supplied photograph for /about Meet the Founder. Use as supplied; do not crop or generate a replacement.",
  },
  {
    file: "resources-page-hero.png",
    ratio: "753 / 287",
    pixelHint: "753 × 287",
    usage: "Resources hero: supplied mug, tools, and workbench crop from the master. Use as supplied; do not generate a replacement.",
  },
  {
    file: "resources-page-guide.png",
    ratio: "219 / 131",
    pixelHint: "219 × 131",
    usage: "Resources featured Guide card crop from the master. Use as supplied.",
  },
  {
    file: "resources-page-template.png",
    ratio: "218 / 131",
    pixelHint: "218 × 131",
    usage: "Resources featured Template card crop from the master. Use as supplied.",
  },
  {
    file: "resources-page-checklist.png",
    ratio: "215 / 131",
    pixelHint: "215 × 131",
    usage: "Resources featured Checklist card crop from the master. Use as supplied.",
  },
  {
    file: "resources-page-video.png",
    ratio: "216 / 131",
    pixelHint: "216 × 131",
    usage: "Resources featured Video card crop from the master. Use as supplied.",
  },
  {
    file: "resources-page-article.png",
    ratio: "210 / 131",
    pixelHint: "210 × 131",
    usage: "Resources featured Article card crop from the master. Use as supplied.",
  },
  {
    file: "resources-page-cta.png",
    ratio: "410 / 183",
    pixelHint: "410 × 183",
    usage: "Resources CTA: supplied back-facing tradesman crop from the master. Use as supplied.",
  },
  {
    file: "og-default.jpg",
    ratio: "1.91 / 1",
    pixelHint: "1200 × 630",
    usage: "Open Graph share image for tbbtools.com. Not shipped yet.",
  },
  {
    file: "founder.jpg",
    ratio: "4 / 5",
    pixelHint: "1200 × 1500",
    usage: "Legacy founder slot. /about uses about-page-founder.png.",
  },
] as const;

export function tbbtPageTitle(page: string): string {
  switch (page) {
    case "home":
      return TBBT_POSITIONING;
    case "features":
      return "Features";
    case "trades":
      return "Trades";
    case "pricing":
      return "Pricing";
    case "about":
      return "About";
    case "resources":
      return "Resources";
    case "privacy":
      return "Privacy";
    case "terms":
      return "Terms";
    case "contact":
      return "Contact";
    default:
      return TBBT_PRODUCT_NAME;
  }
}

export function tbbtPageDescription(page: string): string {
  switch (page) {
    case "home":
      return "TBBT is the business operating system for trades. Website, customers, estimates, jobs, scheduling, and invoices in one workspace. Founder Plan $49/month. 30-day free trial. No credit card required.";
    case "features":
      return "TBBT features: public website, customers, scheduling, estimates, jobs, invoices, time cards, team, reports, reviews, and marketing content in one trades workspace.";
    case "trades":
      return "One TBBT platform for every trade. Handyman is available now. Additional trades are planned on the roadmap after the core platform is completed.";
    case "pricing":
      return `TBBT Founder Plan ${TBBT_FOUNDER_PLAN_PRICE_LABEL}. ${TBBT_FOUNDER_TRIAL_DAYS}-day free trial. No credit card required to begin.`;
    case "about":
      return "TBBT was built by a tradesman for the trades. Founder Daniel LeBlanc is a third-generation carpenter who built TBBT from real field and business problems.";
    case "resources":
      return "TBBT resource hub: guides, templates, checklists, and tools to start, run, and grow a trades business.";
    case "privacy":
      return "Privacy practices for TBBT, the Trades Business Builder Tool.";
    case "terms":
      return "Terms of use for TBBT, including the Founder Plan trial and subscription.";
    case "contact":
      return "Contact TBBT. Start a free trial or sign in to your existing workspace.";
    default:
      return "TBBT — the business operating system for the trades.";
  }
}
