/**
 * Focused verification for the CollPro Reno public website + multi-service
 * public intake (see src/lib/public-site.ts, src/lib/public-intake.ts,
 * src/app/page.tsx, src/app/hire/[slug]/page.tsx, src/app/r/[slug]/page.tsx).
 *
 * Static + pure-function checks always run. Prisma checks use a disposable
 * sibling Postgres database. HTTP checks run when APP_URL is reachable.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-public-website.mjs
 */
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { formatCatalogPriceLabel } = await import("@/lib/pricing-mode");
const { createPublicServiceRequest } = await import("@/lib/public-intake");
const {
  COLLPRO_RENO_DISPLAY_NAME,
  COLLPRO_RENO_PHONE,
  HOW_IT_WORKS_STEPS,
  PUBLIC_PRICING_DISCLAIMER,
  SERVICE_AREA_COPY,
  TRUST_POINTS,
  HOME_FEATURED_PROJECT_IDS,
  groupPublicCatalog,
  isCollProRenoSlug,
  toPublicCatalogItem,
} = await import("@/lib/public-site");
const { selectPublicProjectsById } = await import("@/lib/public-projects");
const {
  parseRequestQuantity,
  parseSelectedTasks,
  requestedWorkLabels,
} = await import("@/lib/service-request-work");
const { draftEstimateLinesFromRequestItems } = await import("@/lib/request-estimate-draft");
const {
  parseSelectedWorkSearch,
  selectedWorkQuery,
  summarizeSelectedWorkPricing,
} = await import("@/lib/selected-work");
const { groupServiceCatalogItemsByCategory } = await import("@/lib/service-catalog-category");

const APP_URL = process.env.APP_URL ?? "http://localhost:43217";
const baseUrl = process.env.DATABASE_URL;

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

const publicFiles = [
  "src/app/page.tsx",
  "src/app/hire/[slug]/page.tsx",
  "src/app/r/[slug]/page.tsx",
  "src/components/public/public-home.tsx",
  "src/components/public/public-header.tsx",
  "src/components/public/public-footer.tsx",
  "src/components/public/public-about.tsx",
  "src/components/public/public-site-shell.tsx",
  "src/components/public/category-cards.tsx",
  "src/components/public/request-flow.tsx",
  "src/components/public/service-picker.tsx",
  "src/components/public/public-contact-form.tsx",
  "src/components/public/public-action-rail.tsx",
  "src/components/public/public-footer-quote.tsx",
  "src/components/public/public-projects-gallery.tsx",
  "src/components/public/public-services-browser.tsx",
  "src/components/public/public-about.tsx",
  "src/app/hire/[slug]/about/page.tsx",
  "src/app/hire/[slug]/services/page.tsx",
  "src/app/hire/[slug]/projects/page.tsx",
  "src/app/hire/[slug]/reviews/page.tsx",
  "src/app/hire/[slug]/service-area/page.tsx",
  "src/app/hire/[slug]/contact/page.tsx",
  "src/lib/public-site.ts",
  "src/lib/public-projects.ts",
  "src/lib/public-intake.ts",
  "src/app/actions/intake.ts",
];
const publicSrc = publicFiles.map(readRepo).join("\n");
const homeSrc = readRepo("src/app/page.tsx");
const hireSrc = readRepo("src/app/hire/[slug]/page.tsx");
const requestPageSrc = readRepo("src/app/r/[slug]/page.tsx");
const requestFlowSrc = readRepo("src/components/public/request-flow.tsx");
const intakeActionSrc = readRepo("src/app/actions/intake.ts");
const estimateActionSrc = readRepo("src/app/actions/estimate.ts");
const estimatePageSrc = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const requestsWorkspaceSrc = readRepo("src/components/requests/requests-workspace.tsx");
const proxySrc = readRepo("src/proxy.ts");

console.log("\nSTATIC — Public website presentation");
check("Public homepage exists for CollPro Reno", homeSrc.includes("COLLPRO_RENO_DISPLAY_NAME") && homeSrc.includes("PublicHome"));
check("Hire page reuses the same public homepage", hireSrc.includes("<PublicHome"));
check("Homepage does not embed the full service catalog picker",
  !readRepo("src/components/public/public-home.tsx").includes("HomeCatalogContinue") &&
    !readRepo("src/components/public/public-home.tsx").includes("ServicePicker"));
check("Recent Projects uses up to six real featured photos",
  HOME_FEATURED_PROJECT_IDS.length === 6 &&
    selectPublicProjectsById(HOME_FEATURED_PROJECT_IDS).length === HOME_FEATURED_PROJECT_IDS.length);
check("Home Recent Projects use a 3-column desktop grid",
  readRepo("src/components/public/public-home.tsx").includes("lg:grid-cols-3"));
check("Home does not expose owner photo replace controls",
  !readRepo("src/components/public/public-home.tsx").includes("Replace Image") &&
    !readRepo("src/components/public/public-home.tsx").includes("Reset to Default"));
check("How It Works has the five real workflow steps", HOW_IT_WORKS_STEPS.length === 5);
check(
  "Service-area copy uses the verified Fort Myers / Cape Coral wording",
  /Fort Myers \/ Cape Coral/.test(SERVICE_AREA_COPY) &&
    !/reno,\s*nevada|naples|lehigh acres|estero|bonita springs|punta gorda/i.test(SERVICE_AREA_COPY),
);
check("No fabricated reviews/testimonials/ratings in public copy",
  !/(google reviews|★★★★★|5-star|testimonial|licensed and insured|years in business)/i.test(publicSrc) &&
    TRUST_POINTS.every((point) => !/award|license|insured|star/i.test(point.body)));
check("No Founder Design Mode on public pages",
  !publicSrc.includes("FounderDesign") && !publicSrc.includes("Founder Design Mode"));
check("No TBBT powered-by lockup on customer pages",
  !/Powered by TBBT/i.test(publicSrc));
check("No public hourly pricing language",
  !/hourly|per hour|\/hr/i.test(publicSrc));
check("No AI provider integration on public intake",
  !/openai|anthropic|@ai-sdk|generateText/i.test(publicSrc));
check("Public intake does not apply labor minimum",
  !intakeActionSrc.includes("labor-minimum") && !intakeActionSrc.includes("laborMinimum"));
check("Existing /r/[slug] intake URL is preserved", requestPageSrc.includes("MultiServiceRequestFlow"));
check("Unauthenticated / is the public homepage, not sign-in",
  proxySrc.includes("isPublicHome") && !proxySrc.includes('hasSession ? "/dashboard" : "/sign-in"'));
check("Services page does not repeat a pre-footer quote CTA",
  !readRepo("src/app/hire/[slug]/services/page.tsx").includes("PublicCtaBar") &&
    !readRepo("src/app/hire/[slug]/services/page.tsx").includes("Ready to get started"));
check("Services page keeps a left category rail, grouped quantity controls, and two-column service options",
  (() => {
    const browser = readRepo("src/components/public/public-services-browser.tsx");
    const css = readRepo("src/components/public/public-site.css");
    return (
      browser.includes("<aside>") &&
      browser.includes("public-cat-rail") &&
      browser.includes("public-service-controls") &&
      browser.includes("public-qty") &&
      css.includes("grid-template-columns: 18.5rem minmax(0, 1fr)") &&
      css.includes(".public-service-options") &&
      css.includes("repeat(2, minmax(0, 1fr))") &&
      !css.includes("public-cat-rail {\n  display: grid;\n  grid-template-columns: repeat(") &&
      !browser.includes("public-services-body")
    );
  })());
check("Request a Quote keeps a compact selected-work summary",
  requestFlowSrc.includes("Your Selected Work") &&
    requestFlowSrc.includes("Add Another Service") &&
    !requestFlowSrc.includes("ServicePicker"));
check("Intake persists structured quantity, not notes-only quantity",
  intakeActionSrc.includes("catalogQuantities") &&
    readRepo("src/lib/public-intake.ts").includes("quantity: task.quantity"));
check("Services Website Photos reuse the existing PublicSiteImage page/slot model",
  readRepo("src/lib/public-site-images.ts").includes("PUBLIC_SITE_SERVICES_PAGE") &&
    readRepo("src/app/hire/[slug]/services/page.tsx").includes("loadPublicServicesImages"));
check("About page uses company/handyman imagery, not project-gallery photos",
  (() => {
    const about = readRepo("src/components/public/public-about.tsx");
    const page = readRepo("src/app/hire/[slug]/about/page.tsx");
    const hero = readRepo("src/components/public/public-page-hero.tsx");
    const site = readRepo("src/lib/public-site.ts");
    return (
      site.includes('PUBLIC_ABOUT_HERO_IMAGE = "/brand/illustrative/craftsman-hero.jpg"') &&
      site.includes('COLLPRO_ABOUT_HERO_IMAGE = "/brand/collpro/about-hero.png"') &&
      site.includes("publicAboutHeroImage") &&
      site.includes('PUBLIC_ABOUT_STORY_IMAGE = "/brand/projects/door-install.jpg"') &&
      page.includes("loadPublicAboutImages") &&
      !hero.includes("collpro/about-hero") &&
      !about.includes("collpro/about-hero") &&
      about.includes("Our Story") &&
      about.includes("Why Homeowners Choose CollPro Reno") &&
      about.includes("What Our Customers Say") &&
      about.includes("Our Service Area") &&
      !about.includes("lanai-porch") &&
      !about.includes("feature-wall-tv") &&
      !about.includes("★★★★★")
    );
  })());
check("About keeps a contextual CTA and Website Photos About slots",
  readRepo("src/app/hire/[slug]/about/page.tsx").includes("PublicCtaBar") &&
    readRepo("src/lib/public-site-images.ts").includes("PUBLIC_SITE_ABOUT_PAGE") &&
    readRepo("src/lib/public-site-images.ts").includes("PUBLIC_SITE_STORY_SLOT"));
check("Website Story keeps raw owner notes separate from approved public copy",
  readRepo("src/lib/website-story.ts").includes("rawOwnerStory is owner background") &&
    readRepo("src/components/settings/website-story-form.tsx").includes("approvedPublicAboutCopy") &&
    readRepo("src/lib/settings.ts").includes('"website-story"'));

console.log("\nSTATIC — Catalog and intake architecture");
check("Public catalog uses persisted categories",
  hireSrc.includes("loadPublicSite") && readRepo("src/lib/public-site.ts").includes("groupServiceCatalogItemsByCategory"));
check("Intake creates ServiceRequestItem rows, not comma-separated IDs",
  readRepo("src/lib/public-intake.ts").includes("serviceRequestItem.createMany") &&
    !readRepo("src/lib/public-intake.ts").includes("join(\",\")"));
check("Browser businessId is accepted only to be ignored",
  readRepo("src/lib/public-intake.ts").includes("Browser-supplied businessId is never authorization"));
check("Internal request detail lists Requested Work",
  requestsWorkspaceSrc.includes("Requested Work") && requestsWorkspaceSrc.includes("requestedTasks.map"));
check("Estimate handoff keeps request context and does not auto-add lines",
  estimatePageSrc.includes("Requested work") &&
    estimateActionSrc.includes("const created = await tx.estimate.create") &&
    !estimateActionSrc.includes("serviceRequestItem"));
check("Photos reuse existing Blob storage helper",
  readRepo("src/lib/storage.ts").includes("uploadRequestPhoto") &&
    intakeActionSrc.includes("uploadRequestPhoto"));

console.log("\nPURE — Pricing labels and requested-work fallback");
check("STARTING_AT displays Starting at $X",
  formatCatalogPriceLabel("STARTING_AT", 85) === "Starting at $85.00");
check("CUSTOM_QUOTE displays Custom Quote",
  formatCatalogPriceLabel("CUSTOM_QUOTE", 85) === "Custom Quote");
check("FIXED may show a fixed labor price",
  formatCatalogPriceLabel("FIXED", 125).includes("$125.00"));
check("No hourly words in pricing labels",
  !/hour/i.test([
    formatCatalogPriceLabel("STARTING_AT", 85),
    formatCatalogPriceLabel("CUSTOM_QUOTE", null),
    formatCatalogPriceLabel("FIXED", 125),
  ].join(" ")));

const grouped = groupPublicCatalog(
  [
    toPublicCatalogItem({
      id: "1",
      name: "Door Adjustment",
      description: "Adjust a door",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: 75,
    }),
    toPublicCatalogItem({
      id: "2",
      name: "Custom odd job",
      description: null,
      category: "Punch Lists / Small Jobs",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
    }),
  ],
  "HANDYMAN",
);
check("Persisted categories are used for grouping",
  grouped[0].category === "Doors & Locks" && grouped[1].category === "Punch Lists / Small Jobs");
check("groupServiceCatalogItemsByCategory is the same helper",
  groupServiceCatalogItemsByCategory([{ id: "1", category: "Doors & Locks" }])[0].category === "Doors & Locks");

const parsedOne = parseSelectedTasks({
  catalogItemIds: ["svc-1"],
  includeOther: false,
  otherDescription: "",
});
const parsedMany = parseSelectedTasks({
  catalogItemIds: ["svc-1", "svc-2", "svc-1"],
  includeOther: false,
  otherDescription: "",
});
const parsedRemoved = parseSelectedTasks({
  catalogItemIds: ["svc-2"],
  includeOther: false,
  otherDescription: "",
});
const parsedOther = parseSelectedTasks({
  catalogItemIds: [],
  includeOther: true,
  otherDescription: "Fix the loose railing",
});
check("Customer can select one service", parsedOne.ok && parsedOne.tasks.length === 1);
check("Customer can select multiple services and duplicates collapse",
  parsedMany.ok && parsedMany.tasks.length === 2);
check("Customer can remove a selected service",
  parsedRemoved.ok && parsedRemoved.tasks.length === 1 && parsedRemoved.tasks[0].serviceCatalogItemId === "svc-2");
check("Other / custom task is supported",
  parsedOther.ok && parsedOther.tasks[0].kind === "other");

check("Quantity 0 is rejected", parseRequestQuantity(0) === null);
check("Quantity 100+ is rejected", parseRequestQuantity(100) === null);
check("Decimal quantity is rejected", parseRequestQuantity("1.5") === null);
check("Negative quantity is rejected", parseRequestQuantity("-2") === null);
check("Nonnumeric quantity is rejected", parseRequestQuantity("abc") === null);
check("Quantity 3 is accepted", parseRequestQuantity(3) === 3);

const parsedQty = parseSelectedTasks({
  catalogItemIds: ["svc-1"],
  catalogQuantities: { "svc-1": 3 },
  includeOther: false,
  otherDescription: "",
});
check("One service with qty 3 stays a single selected task",
  parsedQty.ok && parsedQty.tasks.length === 1 && parsedQty.tasks[0].quantity === 3);
const parsedBadQty = parseSelectedTasks({
  catalogItemIds: ["svc-1"],
  catalogQuantities: { "svc-1": 0 },
  includeOther: false,
  otherDescription: "",
});
check("Invalid submitted quantity is rejected", parsedBadQty.ok === false);

const qtyQuery = selectedWorkQuery({
  catalogIds: ["door", "fan"],
  quantities: { door: 3, fan: 1 },
  includeOther: false,
});
const qtyParsed = parseSelectedWorkSearch({ services: "door:3,fan" });
check("Services query preserves quantities across the Request handoff",
  decodeURIComponent(qtyQuery) === "?services=door:3,fan" &&
    qtyParsed.catalogIds.join(",") === "door,fan" &&
    qtyParsed.quantities.door === 3 &&
    qtyParsed.quantities.fan === 1);

const mixed = summarizeSelectedWorkPricing([
  { pricingMode: "FIXED", unitAmount: 75, quantity: 3 },
  { pricingMode: "STARTING_AT", unitAmount: 75, quantity: 3 },
  { pricingMode: "CUSTOM_QUOTE", unitAmount: null, quantity: 3 },
]);
check("FIXED quantity uses unit price × quantity", mixed.fixedTotal === 225);
check("STARTING_AT quantity uses a starting subtotal", mixed.startingTotal === 225);
check("CUSTOM_QUOTE keeps quantity but invents no price",
  mixed.customCount === 1 && mixed.estimatedStartingTotal === 450);
check("Mixed summary does not treat starting work as a guaranteed total",
  mixed.allFixed === false);

const draftLines = draftEstimateLinesFromRequestItems([
  {
    quantity: 3,
    serviceCatalogItem: { name: "Door Knob Replacement", pricingMode: "FIXED", price: 75 },
  },
  {
    quantity: 2,
    customDescription: "Custom carpentry",
    serviceCatalogItem: null,
  },
]);
check("Estimate-draft helper keeps quantity and catalog pricing ready",
  draftLines[0]?.quantity === 3 &&
    draftLines[0]?.unitPrice === 75 &&
    draftLines[1]?.priced === false);
const createEstimateFn = estimateActionSrc.slice(
  estimateActionSrc.indexOf("export async function createEstimate"),
  estimateActionSrc.indexOf("async function findReusableCustomer"),
);
check("Owner estimate creation remains a draft handoff, not an auto-send",
  createEstimateFn.includes("tx.estimate.create") &&
    !createEstimateFn.includes("lineItems") &&
    !createEstimateFn.includes("SENT") &&
    !createEstimateFn.includes("APPROVED"));

check("Legacy request with only serviceCatalogItem remains readable",
  requestedWorkLabels({
    items: [],
    serviceCatalogItem: { name: "TV Mounting" },
  }).join(",") === "TV Mounting");
check("Multi-item request labels stay as a list, not a blob of IDs",
  requestedWorkLabels({
    items: [
      { serviceCatalogItem: { name: "Door Adjustment" } },
      { serviceCatalogItem: { name: "TV Mounting" } },
      { customDescription: "Caulking" },
    ],
  }).join("|") === "Door Adjustment|TV Mounting|Caulking");
check("CollPro slug mapping is recognized",
  isCollProRenoSlug("collpro-reno") && isCollProRenoSlug("collpro-reno-handyman-services"));
check("CollPro phone and name are the verified launch values",
  COLLPRO_RENO_PHONE === "239-357-8199" &&
    COLLPRO_RENO_DISPLAY_NAME === "CollPro Reno Handyman Services");
check("Pricing disclaimer is truthful starting-price language",
  PUBLIC_PRICING_DISCLAIMER.includes("starting labor prices"));

if (!baseUrl) {
  console.error("\nDATABASE_URL must be set to run intake persistence checks.");
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(1);
}

const testDbName = "tbbt_public_website_test";
const parsedUrl = new URL(baseUrl);
parsedUrl.pathname = `/${testDbName}`;
const testUrl = parsedUrl.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for public website test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Multi-service intake and tenant isolation");
  const businessA = await prisma.business.create({
    data: { name: "CollPro Reno Handyman Services", slug: "collpro-reno", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Other Handyman", slug: "other-handyman", tradeCode: "HANDYMAN" },
  });
  const door = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Door Adjustment",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(75),
      active: true,
    },
  });
  const tv = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "TV Mounting",
      category: "Mounting & Hanging",
      pricingMode: "FIXED",
      price: new Prisma.Decimal(150),
      active: true,
    },
  });
  const quote = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Custom Carpentry",
      category: "Trim & Carpentry",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
    },
  });
  const inactive = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Hidden Internal Service",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(999),
      active: false,
    },
  });
  const foreign = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessB.id,
      name: "Foreign Service",
      category: "Doors & Locks",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(40),
      active: true,
    },
  });

  const one = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    businessId: businessB.id,
    name: "Ada Homeowner",
    email: "ada@example.com",
    phone: "555-0100",
    address: "10 Main St",
    notes: "Door sticks.",
    catalogItemIds: [door.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Single selected service creates one ServiceRequest", one.ok === true);

  const many = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Bea Homeowner",
    email: "bea@example.com",
    phone: "555-0101",
    address: "11 Main St",
    notes: "Several small jobs.",
    catalogItemIds: [door.id, tv.id, quote.id],
    includeOther: true,
    otherDescription: "Caulking around the tub",
  });
  check("Multiple selected tasks create ONE ServiceRequest", many.ok === true);

  const createdMany = many.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: many.requestId },
        include: { items: true, estimates: true, photos: true },
      })
    : null;
  check("Selected tasks persist as ServiceRequestItem rows",
    createdMany?.items.length === 4);

  const qtyRequest = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Quincy Homeowner",
    email: "quincy@example.com",
    phone: "555-0199",
    address: "99 Qty St",
    notes: "Three door knobs.",
    catalogItemIds: [door.id],
    catalogQuantities: { [door.id]: 3 },
    includeOther: false,
    otherDescription: "",
  });
  const qtyRow = qtyRequest.ok
    ? await prisma.serviceRequestItem.findFirst({
        where: { serviceRequestId: qtyRequest.requestId },
      })
    : null;
  check("ServiceRequestItem quantity persists as structured data",
    qtyRow?.quantity === 3 && qtyRow?.serviceCatalogItemId === door.id);

  const rejectedZero = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Zero Qty",
    email: "zero@example.com",
    phone: "555-0180",
    address: "",
    notes: "",
    catalogItemIds: [door.id],
    catalogQuantities: { [door.id]: 0 },
    includeOther: false,
    otherDescription: "",
  });
  const rejectedHigh = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "High Qty",
    email: "high@example.com",
    phone: "555-0181",
    address: "",
    notes: "",
    catalogItemIds: [door.id],
    catalogQuantities: { [door.id]: 100 },
    includeOther: false,
    otherDescription: "",
  });
  const rejectedDecimal = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Dec Qty",
    email: "dec@example.com",
    phone: "555-0182",
    address: "",
    notes: "",
    catalogItemIds: [door.id],
    catalogQuantities: { [door.id]: "1.5" },
    includeOther: false,
    otherDescription: "",
  });
  check("Quantity 0 is rejected at persistence", rejectedZero.ok === false);
  check("Quantity 100+ is rejected at persistence", rejectedHigh.ok === false);
  check("Decimal quantity is rejected at persistence", rejectedDecimal.ok === false);
  check("Client-supplied unit prices are not a persistence field",
    !("unitPrice" in (qtyRow ?? {})));
  check("Legacy serviceCatalogItemId is the first catalog item only",
    createdMany?.serviceCatalogItemId === door.id);
  check("No automatic Estimate creation", createdMany?.estimates.length === 0);

  const jobs = many.ok
    ? await prisma.job.count({ where: { businessId: businessA.id } })
    : -1;
  const invoices = many.ok
    ? await prisma.invoice.count({ where: { businessId: businessA.id } })
    : -1;
  check("No automatic Job creation", jobs === 0);
  check("No automatic Invoice creation", invoices === 0);

  const otherOnly = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Cara Homeowner",
    email: "",
    phone: "555-0102",
    address: "",
    notes: "",
    catalogItemIds: [],
    includeOther: true,
    otherDescription: "Something else entirely",
  });
  check("Other-only request is allowed", otherOnly.ok === true);

  const rejectedForeign = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Eve Homeowner",
    email: "eve@example.com",
    phone: "555-0103",
    address: "",
    notes: "Trying another tenant's service",
    catalogItemIds: [foreign.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Cross-business ServiceCatalogItem is rejected", rejectedForeign.ok === false);

  const rejectedInactive = await createPublicServiceRequest(prisma, {
    slug: "collpro-reno",
    name: "Fay Homeowner",
    email: "fay@example.com",
    phone: "555-0104",
    address: "",
    notes: "Trying an inactive service",
    catalogItemIds: [inactive.id],
    includeOther: false,
    otherDescription: "",
  });
  check("Inactive catalog items are rejected", rejectedInactive.ok === false);

  const ignoredBusinessId = one.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: one.requestId } })
    : null;
  check("Public intake cannot choose arbitrary businessId",
    ignoredBusinessId?.businessId === businessA.id);

  const leaked = await prisma.customer.findMany({
    where: { businessId: businessB.id },
  });
  check("Customer/CRM records stay on the resolved business", leaked.length === 0);

  const legacy = await prisma.serviceRequest.create({
    data: {
      businessId: businessA.id,
      description: "Old single-service request",
      serviceCatalogItemId: tv.id,
    },
    include: { serviceCatalogItem: { select: { name: true } }, items: true },
  });
  check("Existing legacy ServiceRequest remains readable without items",
    legacy.items.length === 0 &&
      requestedWorkLabels(legacy).join(",") === "TV Mounting");

  const estimate = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      serviceRequestId: createdMany?.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
    include: { lineItems: true, jobs: true },
  });
  const estimateTasks = createdMany ? requestedWorkLabels({
    items: await prisma.serviceRequestItem.findMany({
      where: { serviceRequestId: createdMany.id },
      include: { serviceCatalogItem: { select: { name: true } } },
    }),
  }) : [];
  check("Estimate handoff retains requested-task context",
    estimateTasks.some((label) => label.includes("Door Adjustment")) &&
      estimateTasks.some((label) => label.includes("TV Mounting")) &&
      estimateTasks.some((label) => label.includes("Caulking around the tub")));
  check("Creating an estimate from a request does not auto-add priced lines",
    estimate.lineItems.length === 0 && estimate.jobs.length === 0);

  const publicItems = (await prisma.serviceCatalogItem.findMany({
    where: { businessId: businessA.id, active: true },
  })).map(toPublicCatalogItem);
  check("Real active catalog is the public list",
    publicItems.length === 3 && publicItems.every((item) => item.id !== inactive.id));
  check("Public items expose no internal pricing intelligence",
    publicItems.every((item) =>
      !("cost" in item) && !("margin" in item) && !("hourlyRate" in item)));
  check("STARTING_AT and CUSTOM_QUOTE labels stay truthful on real rows",
    publicItems.find((item) => item.id === door.id)?.priceLabel === "Starting at $75.00" &&
      publicItems.find((item) => item.id === quote.id)?.priceLabel === "Custom Quote");

  async function fetchMaybe(path) {
    try {
      const res = await fetch(`${APP_URL}${path}`, { redirect: "manual" });
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
    console.log("\nHTTP — Public pages");
    const home = await fetchMaybe("/");
    check("Public homepage loads", Boolean(home && home.status === 200 && home.body.includes(COLLPRO_RENO_DISPLAY_NAME)));
    check("Homepage does not expose Founder Design Mode",
      Boolean(home && !home.body.includes("Founder Design Mode")));
    check("Homepage does not fabricate reviews",
      Boolean(home && !/★★★★★|google reviews|testimonial/i.test(home.body)));
    check("Homepage does not show hourly pricing",
      Boolean(home && !/hourly|per hour/i.test(home.body)));
    check("Homepage does not expose Knowledge Hub / expenses / payroll",
      Boolean(home && !/Knowledge Hub|Payroll|Expenses/.test(home.body)));

    const hire = await fetchMaybe("/hire/collpro-reno");
    check("Existing /hire/collpro-reno homepage still loads",
      Boolean(hire && hire.status === 200 && hire.body.includes(COLLPRO_RENO_DISPLAY_NAME)));

    const services = await fetchMaybe("/hire/collpro-reno/services");
    check("Services page loads",
      Boolean(services && services.status === 200 && services.body.includes("Selected Work")));
    check("Services page includes quantity controls",
      Boolean(services && services.body.includes("public-qty")));
    check("Services page keeps the left category rail",
      Boolean(services && services.body.includes("public-cat-rail") &&
        services.body.includes("public-service-controls")));
    check("Services HTTP page has no pre-footer Ready to get started CTA",
      Boolean(services && !/Ready to get started/i.test(services.body)));

    const about = await fetchMaybe("/hire/collpro-reno/about");
    check("About page loads the restored company story layout",
      Boolean(about && about.status === 200 &&
        about.body.includes("Our Story") &&
        about.body.includes("Why Homeowners Choose CollPro Reno") &&
        about.body.includes("What Our Customers Say") &&
        !/★★★★★|google reviews/i.test(about.body)));

    const intake = await fetchMaybe("/r/collpro-reno");
    check("Existing /r/collpro-reno intake still loads",
      Boolean(intake && intake.status === 200 && intake.body.includes("Request Service")));
    check("Intake does not expose Founder Design Mode",
      Boolean(intake && !intake.body.includes("Founder Design Mode")));
    check("Intake does not leak employee/private data",
      Boolean(intake && !intake.body.includes("hourlyWage") && !intake.body.includes("isFounder")));
  }
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failed === 0
    ? `\nAll public website checks passed (${passed}).`
    : `\n${passed} passed, ${failed} failed.`,
);
process.exit(failed > 0 ? 1 : 0);
