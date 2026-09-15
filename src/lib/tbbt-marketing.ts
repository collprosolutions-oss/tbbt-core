/**
 * Copy, navigation, and honest capability inventory for the TBBT
 * corporate marketing site. This is not the CollPro tenant website.
 *
 * Feature claims are limited to capabilities that exist in this
 * application, or are explicitly labeled planned / coming.
 */
import {
  TBBT_FOUNDER_PLAN_PRICE_LABEL,
  TBBT_FOUNDER_TRIAL_DAYS,
} from "@/lib/saas-billing/founder-price";
import { TBBT_SAAS_PLAN_NAME } from "@/lib/saas-billing/config";

export const TBBT_PRODUCT_NAME = "TBBT";
export const TBBT_PRODUCT_LONG_NAME = "Trades Business Builder Tool";
export const TBBT_TAGLINE = "More Than Tools. A Better Way Forward.";
export const TBBT_BRAND_MOTTO = "Build. Run. Grow.";
export const TBBT_POSITIONING =
  "The All-In-One Business Operating System for the Trades.";
export const TBBT_SIGN_IN_HREF = "/sign-in";
export const TBBT_SIGN_UP_HREF = "/sign-up";
export const TBBT_TRIAL_CTA_LABEL = "Start Your Free 30-Day Trial";
export const TBBT_TRIAL_NAV_LABEL = "Start Free Trial";

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
  "The All-In-One",
  "Business Operating",
  "System for the Trades.",
] as const;

export const TBBT_HERO_SUPPORT =
  "TBBT helps trades businesses build a professional website, manage customers, schedule work, create estimates, run jobs, invoice, track time, organize teams, market the business, understand performance, and grow — in one connected operating system.";

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
    status: "coming-next",
    summary: "Next trade template. Same operating system, cleaning-specific setup.",
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
  "coming-next": "Coming Next",
  planned: "Planned",
};

export const TBBT_PILLARS = [
  {
    kicker: "Build",
    title: "A Professional Website for Your Business",
    body: "Stand up a public site with services, service areas, photos, reviews, and lead capture so customers can request work before you ever pick up the phone.",
    points: [
      "Website setup and trade templates",
      "Services customers can actually request",
      "Service area and contact details",
      "Project photos you choose to show",
      "Reviews you record and display",
      "Lead capture into your workspace",
    ],
  },
  {
    kicker: "Run",
    title: "Manage Your Day With Ease",
    body: "The same customer who requested work on the website becomes a record you can estimate, schedule, job, invoice, and pay — without rebuilding the story in another app.",
    points: [
      "Customers and requests (CRM)",
      "Scheduling and jobs",
      "Estimates and quotes",
      "Invoices and customer payments",
      "Time cards",
      "Team members and roles",
    ],
  },
  {
    kicker: "Grow",
    title: "A Business Partner That Works for You",
    body: "Use what the business already recorded — jobs, invoices, time, and reviews — to see performance and prepare marketing. Software should reduce owner stress and create freedom, not become another job.",
    points: [
      "Reports from TBBT records",
      "Marketing content from completed work",
      "Review tracking",
      "Knowledge hub for how the business actually works",
      "Business Success / AI coaching — planned, not in production",
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
    title: "Website Builder",
    body: "Set up the public business website: services, service area, photos, about copy, and a request path that creates a real lead.",
    href: "/features#website-builder",
    status: "live" as const,
  },
  {
    title: "Leads & CRM",
    body: "Public requests become customers and pipeline records you can work — not a disconnected inbox.",
    href: "/features#leads-crm",
    status: "live" as const,
  },
  {
    title: "Scheduling",
    body: "Put approved work on the calendar, see today's jobs, and keep the field and office on the same schedule.",
    href: "/features#scheduling",
    status: "live" as const,
  },
  {
    title: "Estimates & Quotes",
    body: "Build written estimates from catalog work, send them for approval, and turn approved scope into a job.",
    href: "/features#estimates",
    status: "live" as const,
  },
  {
    title: "Jobs & Task Management",
    body: "Run the job after the estimate is approved: status, photos, additional work, and completion into invoicing.",
    href: "/features#jobs",
    status: "live" as const,
  },
  {
    title: "Invoices & Payments",
    body: "Invoice from completed work and collect customer payments when Stripe Connect is configured for that business.",
    href: "/features#invoices",
    status: "live" as const,
  },
  {
    title: "Time Tracking",
    body: "Time cards for the people doing the work, with payroll support from recorded hours — not guessed totals.",
    href: "/features#time-tracking",
    status: "live" as const,
  },
  {
    title: "Team Management",
    body: "Invite team members, assign roles, and keep field access separate from owner/admin work.",
    href: "/features#team",
    status: "live" as const,
  },
  {
    title: "Marketing Tools",
    body: "Prepare content from completed jobs and approved photos. Social channels are intent/draft only — TBBT does not currently publish posts for you.",
    href: "/features#marketing",
    status: "live" as const,
  },
  {
    title: "Reports & Business Insights",
    body: "Reports over invoices, jobs, customers, time, and expenses recorded in TBBT. This is not a full accounting suite.",
    href: "/features#reports",
    status: "live" as const,
  },
] as const;

export const TBBT_ADDITIONAL_FEATURES = [
  {
    title: "Expenses",
    body: "Record job and business expenses inside the workspace.",
    status: "live" as const,
  },
  {
    title: "Knowledge Hub",
    body: "Owner-recorded operating knowledge. There is no AI writer in production.",
    status: "live" as const,
  },
  {
    title: "Reviews",
    body: "Record customer reviews and draft responses. TBBT does not invent testimonials.",
    status: "live" as const,
  },
  {
    title: "Material takeoff helpers",
    body: "Takeoff worksheets for scoped estimate lines. They do not invent production rates.",
    status: "live" as const,
  },
  {
    title: "Business Success / AI coaching",
    body: "Direction for later. Not a production feature today.",
    status: "planned" as const,
  },
] as const;

export const TBBT_FOUNDER_PRICE_LABEL = TBBT_FOUNDER_PLAN_PRICE_LABEL;
export const TBBT_FOUNDER_PLAN_DISPLAY_NAME = TBBT_SAAS_PLAN_NAME;
export const TBBT_FOUNDER_TRIAL_LABEL = `${TBBT_FOUNDER_TRIAL_DAYS}-Day Free Trial`;

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
    body: "Handyman is first. Cleaning is next. The operating system is built to add trades without starting over.",
  },
] as const;

export const TBBT_RESOURCE_CATEGORIES = [
  {
    title: "Business Setup",
    body: "Getting a trades business organized online and in the shop.",
  },
  {
    title: "Pricing & Estimating",
    body: "How to quote work without guessing the whole job from a text message.",
  },
  {
    title: "Marketing & Growth",
    body: "Showing the work, asking for reviews, and turning one job into the next.",
  },
  {
    title: "Templates & Forms",
    body: "Reusable checklists and forms for the field and the office.",
  },
  {
    title: "Operations & Scheduling",
    body: "Keeping the calendar honest when the work changes mid-day.",
  },
  {
    title: "Industry Insights",
    body: "Notes from the trades, not generic startup advice.",
  },
] as const;

/**
 * Replaceable photography slots. Files are not shipped until founder
 * photography is approved. Do not 404-request these paths yet.
 *
 * Place finished assets under public/brand/tbbt-marketing/ using these
 * names, then wire them in src/components/tbbt-marketing/.
 */
export const TBBT_MARKETING_ASSET_SLOTS = [
  {
    file: "hero-product.jpg",
    ratio: "16 / 10",
    pixelHint: "1600 × 1000",
    usage: "Optional hero still of the product UI. The live hero uses an HTML product frame until this exists.",
  },
  {
    file: "og-default.jpg",
    ratio: "1.91 / 1",
    pixelHint: "1200 × 630",
    usage: "Open Graph share image for tbbtools.com.",
  },
  {
    file: "trades-mosaic.jpg",
    ratio: "16 / 9",
    pixelHint: "1920 × 1080",
    usage: "Multi-trade photography mosaic. Must not be a single handyman portrait used as the brand.",
  },
  {
    file: "founder.jpg",
    ratio: "4 / 5",
    pixelHint: "1200 × 1500",
    usage: "Optional founder portrait for /about.",
  },
  {
    file: "trade-handyman.jpg",
    ratio: "4 / 3",
    pixelHint: "1200 × 900",
    usage: "Handyman trade card.",
  },
  {
    file: "trade-cleaning.jpg",
    ratio: "4 / 3",
    pixelHint: "1200 × 900",
    usage: "Cleaning trade card.",
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
      return "TBBT is the all-in-one business operating system for the trades. Build the website, run the work, and grow the business from one connected system.";
    case "features":
      return "Website builder, CRM, scheduling, estimates, jobs, invoices, time tracking, team, marketing, and reports — the TBBT operating system for trades businesses.";
    case "trades":
      return "One TBBT platform for every trade. Handyman is available now. Cleaning is next. Other trades are planned on the same operating system.";
    case "pricing":
      return `TBBT Founder Plan ${TBBT_FOUNDER_PLAN_PRICE_LABEL}. ${TBBT_FOUNDER_TRIAL_DAYS}-day free trial. No credit card required to begin.`;
    case "about":
      return "TBBT was built by a tradesman for the trades. Founder Daniel LeBlanc is a third-generation carpenter who built TBBT from real field and business problems.";
    case "resources":
      return "TBBT resource hub for business setup, estimating, marketing, operations, and industry insights. Library content is being added.";
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
