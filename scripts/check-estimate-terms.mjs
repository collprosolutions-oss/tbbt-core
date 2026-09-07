/**
 * Customer estimate project conditions + reusable trade-aware terms.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-estimate-terms.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  composeEstimateTerms,
  partitionEstimateTerms,
  resolveEstimateDocumentTerms,
  resolveEstimateTermPack,
} = await import("@/lib/estimate-terms/compose");
const {
  PROJECT_CONDITIONS_TITLE,
  TERMS_AND_CONDITIONS_TITLE,
} = await import("@/lib/estimate-terms/types");
const { projectConditionStatements } = await import(
  "@/lib/estimate-terms/project-conditions"
);
const { stampDraftEstimateTerms } = await import("@/lib/estimate-terms/stamp");
const { joinLineDescription, lineCustomerPolicies } =
  await import("@/lib/estimate-line-scope");
const { mergeCustomerPolicies } = await import("@/lib/estimate-policies");
const {
  estimateDocumentPlainText,
  loadEstimateDocumentForBusiness,
} = await import("@/lib/estimate-document");
const { renderEstimatePdf } = await import("@/lib/estimate-pdf");
const { createEstimateVersionSnapshot } = await import("@/lib/estimate-version");
const { joinRequestDescription } = await import("@/lib/work-area-intake");
const { applyDraftEstimateCalculator } = await import("@/lib/estimate-line-ops");
const {
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
} = await import("@/lib/estimate-calculators");

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function pdfExtractText(buffer) {
  const raw = buffer.toString("latin1");
  const hex = [...raw.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((match) => {
      try {
        return Buffer.from(match[1], "hex").toString("utf8");
      } catch {
        return "";
      }
    })
    .join("");
  const literals = [...raw.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]).join("");
  return `${hex}\n${literals}`;
}

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

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

const hasTitle = (policies, title) => policies.some((policy) => policy.title === title);

console.log("\nSTATIC — Terms architecture stays reusable and customer-safe");

const schema = readRepo("prisma/schema.prisma");
const ownerPage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const customerPage = readRepo("src/app/e/[token]/page.tsx");
const sendAction = readRepo("src/app/actions/estimate.ts");
const invoiceHtml = readRepo("src/components/invoices/invoice-document.tsx");
const templates = readRepo("src/lib/estimate-terms/templates.ts");

check(
  "No Prisma terms/policy columns were added",
  !schema.includes("projectConditions") &&
    !schema.includes("termsAndConditions") &&
    !schema.includes("customerPolicies"),
);
const sendFn = sendAction.slice(sendAction.indexOf("export async function sendEstimate"));
check(
  "Send stamps composed terms before the version snapshot",
  sendFn.includes("stampDraftEstimateTerms") &&
    sendFn.indexOf("stampDraftEstimateTerms") <
      sendFn.indexOf("createEstimateVersionSnapshot"),
);
check(
  "Owner DRAFT page reviews terms without rewriting the calculator",
  ownerPage.includes("EstimateTermsEditor") &&
    ownerPage.includes("VariableScopeCalculatorForm"),
);
check(
  "Customer estimate/print surfaces share EstimateCustomerPolicies / document terms",
  customerPage.includes("EstimateCustomerPolicies") &&
    customerPage.includes("projectConditions") &&
    customerPage.includes("terms={estimate.terms}"),
);
check(
  "Invoice HTML does not reproduce estimate contract sections",
  !invoiceHtml.includes(PROJECT_CONDITIONS_TITLE) &&
    !invoiceHtml.includes(TERMS_AND_CONDITIONS_TITLE),
);
check(
  "Default templates do not invent a warranty period or cancellation fee",
  !/warranty period|30 days|cancellation fee|non-refundable/i.test(templates),
);

console.log("\nUNIT — Pack selection, intake statements, optional terms");

check(
  "concrete takeoff uses the construction pack",
  resolveEstimateTermPack({
    titles: ["Patio slab"],
    takeoffType: "concrete-slab",
  }) === "construction",
);
check(
  "cleaning titles use the cleaning pack",
  resolveEstimateTermPack({ titles: ["House Cleaning"] }) === "cleaning",
);
check(
  "construction takeoff wins over a title that mentions clean",
  resolveEstimateTermPack({
    titles: ["Clean and pour slab"],
    takeoffType: "concrete-slab",
  }) === "construction",
);

const unanswered = projectConditionStatements(null);
const partial = projectConditionStatements({ answers: [] });
const answered = projectConditionStatements({
  answers: [
    {
      catalogItemId: "svc-1",
      contentsHandling: "clear",
      contentsProtection: "light",
      belongingsCleanup: "none",
    },
  ],
});
check("unanswered intake does not fabricate project conditions", unanswered.length === 0);
check("empty answers do not fabricate project conditions", partial.length === 0);
check(
  "answered intake becomes readable customer statements",
  answered.includes("Work area will be reasonably clear and accessible before work begins.") &&
    answered.includes("Contractor will provide light protection for remaining belongings.") &&
    answered.includes("Additional belongings cleanup is not included.") &&
    !answered.join(" ").includes("contentsHandling") &&
    !answered.join(" ").includes("svc-1"),
);

const construction = composeEstimateTerms({
  titles: ["Patio slab"],
  takeoffType: "concrete-slab",
  hasMaterials: true,
  hasDeposit: true,
});
const constructionVisible = partitionEstimateTerms(construction).terms;
check(
  "construction estimate gets core + construction trade terms",
  hasTitle(constructionVisible, "Scope of Work") &&
    hasTitle(constructionVisible, "Unforeseen / Concealed Conditions") &&
    hasTitle(constructionVisible, "Construction / Renovation Conditions") &&
    hasTitle(constructionVisible, "Material Deposit") &&
    constructionVisible.some((term) =>
      term.body.includes("part of the estimate total, not an additional fee"),
    ),
);
check(
  "construction estimate does not receive cleaning trade terms",
  !hasTitle(constructionVisible, "Cleaning Access & Utilities") &&
    !hasTitle(constructionVisible, "Cleaning Scope Limits"),
);
check(
  "customer-supplied materials stay off until enabled",
  !hasTitle(constructionVisible, "Customer-Supplied Materials") &&
    construction.some(
      (policy) =>
        policy.id === "core-customer-supplied-materials" && policy.disabled === true,
    ),
);

const enabledSupplied = composeEstimateTerms({
  titles: ["Patio slab"],
  takeoffType: "concrete-slab",
  hasMaterials: true,
  existing: [
    {
      id: "core-customer-supplied-materials",
      title: "Customer-Supplied Materials",
      body: "Customer supplied the mix.",
      family: "core",
      optional: true,
    },
  ],
});
check(
  "enabling the optional customer-supplied term shows it",
  hasTitle(partitionEstimateTerms(enabledSupplied).terms, "Customer-Supplied Materials"),
);

const cleaning = partitionEstimateTerms(
  composeEstimateTerms({ titles: ["Move-out cleaning"] }),
).terms;
check(
  "cleaning estimate gets cleaning trade terms",
  hasTitle(cleaning, "Cleaning Access & Utilities") &&
    hasTitle(cleaning, "Cleaning Belongings & Valuables") &&
    hasTitle(cleaning, "Cleaning Scope Limits") &&
    hasTitle(cleaning, "Scope of Work"),
);
check(
  "cleaning estimate does not receive construction concealed-condition terms",
  !hasTitle(cleaning, "Unforeseen / Concealed Conditions") &&
    !hasTitle(cleaning, "Construction / Renovation Conditions"),
);

const frozenWording = "Historical unforeseen wording that must not change.";
const frozen = resolveEstimateDocumentTerms({
  freezeSnapshot: true,
  existing: [
    {
      id: "core-unforeseen-conditions",
      title: "Unforeseen / Concealed Conditions",
      body: frozenWording,
      family: "core",
    },
  ],
  titles: ["House Cleaning"],
  intake: {
    answers: [
      {
        catalogItemId: "ignored",
        contentsHandling: "heavy",
        contentsProtection: "heavy",
        belongingsCleanup: "heavy",
      },
    ],
  },
});
check(
  "frozen SENT snapshots do not recompose live templates or intake",
  frozen.terms.length === 1 &&
    frozen.terms[0].body === frozenWording &&
    frozen.projectConditions == null &&
    !hasTitle(frozen.terms, "Cleaning Access & Utilities"),
);

const merged = mergeCustomerPolicies(
  [
    {
      id: "core-scope-of-work",
      title: "Scope of Work",
      body: "Stamped scope.",
      family: "core",
    },
    {
      id: "work-area-personal-property",
      title: "Work Area & Personal Property",
      body: "Original work-area.",
    },
  ],
  [
    {
      id: "work-area-personal-property",
      title: "Work Area & Personal Property",
      body: "Edited work-area.",
    },
  ],
);
check(
  "calculator policy updates merge instead of replacing core terms",
  hasTitle(merged, "Scope of Work") &&
    merged.find((policy) => policy.id === "work-area-personal-property")?.body ===
      "Edited work-area.",
);

const override = composeEstimateTerms({
  titles: ["Patio slab"],
  existing: [
    {
      id: "core-scope-of-work",
      title: "Scope of Work",
      body: "Estimate-specific scope wording.",
      family: "core",
    },
    {
      id: "business-custom-1",
      title: "Weather hold",
      body: "Exterior pours pause for rain.",
      family: "business",
    },
    {
      id: "core-permits",
      title: "Permits / Inspections",
      body: "Permits are included only when listed.",
      family: "core",
      optional: true,
      disabled: true,
    },
  ],
});
const overrideTerms = partitionEstimateTerms(override).terms;
check(
  "estimate-specific edits and business terms are preserved",
  overrideTerms.find((term) => term.id === "core-scope-of-work")?.body ===
    "Estimate-specific scope wording." &&
    hasTitle(overrideTerms, "Weather hold") &&
    !hasTitle(overrideTerms, "Permits / Inspections"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const testDbName = "tbbt_estimate_terms_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
process.env.DATABASE_URL = testUrl;

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for estimate-terms test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  const business = await prisma.business.create({
    data: {
      name: "Terms Architecture Co",
      slug: `terms-arch-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const otherBusiness = await prisma.business.create({
    data: {
      name: "Other Terms Tenant",
      slug: `terms-other-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: "Alex Patron" },
  });
  const ownerUser = await prisma.user.create({
    data: {
      email: `terms-owner-${randomUUID()}@example.com`,
      name: "Owner",
      passwordHash: "x",
    },
  });
  const membership = await prisma.membership.create({
    data: { businessId: business.id, userId: ownerUser.id, role: "OWNER" },
  });
  const ownerAccess = makeAccess(business.id, "OWNER", membership.id);

  const request = await prisma.serviceRequest.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      summary: "Patio slab",
      description: joinRequestDescription("Customer notes stay owner-only.", {
        answers: [
          {
            catalogItemId: "slab-service",
            contentsHandling: "clear",
            contentsProtection: "light",
            belongingsCleanup: "none",
          },
        ],
      }),
      status: "OPEN",
    },
  });

  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      serviceRequestId: request.id,
      status: "DRAFT",
      total: new Prisma.Decimal(1086.32),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      description: joinLineDescription("Patio slab", "Form, pour, and finish."),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(792),
      total: new Prisma.Decimal(792),
      type: "LABOR",
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      description: joinLineDescription("60-lb concrete bags"),
      quantity: new Prisma.Decimal(22),
      unitPrice: new Prisma.Decimal(13.38),
      total: new Prisma.Decimal(294.36),
      type: "MATERIAL",
    },
  });

  console.log("\nTEST — Draft compose, stamp, print/PDF, and SENT freeze");
  const draftDoc = await loadEstimateDocumentForBusiness(
    estimate.id,
    business.id,
    prisma,
  );
  const draftPlain = draftDoc ? estimateDocumentPlainText(draftDoc) : "";
  check("draft document loads", Boolean(draftDoc));
  check(
    "project conditions appear from intake answers",
    draftDoc?.projectConditions?.title === PROJECT_CONDITIONS_TITLE &&
      draftDoc.projectConditions.body.includes("reasonably clear and accessible") &&
      draftDoc.projectConditions.body.includes("light protection") &&
      draftDoc.projectConditions.body.includes("Additional belongings cleanup is not included"),
  );
  check(
    "raw intake JSON/codes stay off the customer document",
    !draftPlain.includes("contentsHandling") &&
      !draftPlain.includes("TBBT Work Area Intake") &&
      !draftPlain.includes("slab-service") &&
      !draftPlain.includes("catalogItemId"),
  );
  check(
    "MATERIALS Qty heading is on the customer document",
    draftPlain.includes("Qty") &&
      draftDoc?.materialLines[0]?.quantityLabel === "22" &&
      draftDoc.materialLines[0]?.showLinePricing === false,
  );
  check(
    "construction terms are present and cleaning terms are not",
    hasTitle(draftDoc?.terms ?? [], "Unforeseen / Concealed Conditions") &&
      hasTitle(draftDoc?.terms ?? [], "Scope of Work") &&
      !hasTitle(draftDoc?.terms ?? [], "Cleaning Access & Utilities"),
  );
  check(
    "material deposit remains part of the estimate total",
    draftDoc?.totalLabel === "$1,086.32" &&
      draftDoc?.materialDepositLabel === "$294.36" &&
      draftDoc?.terms.some((term) =>
        term.body.includes("part of the estimate total, not an additional fee"),
      ) === true,
  );

  await stampDraftEstimateTerms(prisma, {
    estimateId: estimate.id,
    businessId: business.id,
  });
  const stampedPolicies = lineCustomerPolicies(
    (
      await prisma.lineItem.findFirst({
        where: { estimateId: estimate.id, type: "LABOR" },
      })
    )?.description,
  );
  check(
    "stamping writes composed terms onto the labor line",
    hasTitle(stampedPolicies, "Scope of Work") &&
      stampedPolicies.some((policy) => policy.id === "project-conditions"),
  );

  await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: estimate.id, businessId: business.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    await createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: business.id,
    });
  });

  const sentDoc = await loadEstimateDocumentForBusiness(
    estimate.id,
    business.id,
    prisma,
  );
  const sentPdf = sentDoc ? pdfExtractText(await renderEstimatePdf(sentDoc)) : "";
  check(
    "sent print/PDF keep project conditions and terms",
    sentDoc?.projectConditions?.body.includes("reasonably clear") === true &&
      hasTitle(sentDoc?.terms ?? [], "Scope of Work") &&
      sentPdf.includes(PROJECT_CONDITIONS_TITLE) &&
      sentPdf.includes(TERMS_AND_CONDITIONS_TITLE) &&
      sentPdf.includes("Scope of Work") &&
      sentPdf.includes("QTY"),
  );
  check(
    "other tenant cannot load the estimate document",
    (await loadEstimateDocumentForBusiness(estimate.id, otherBusiness.id, prisma)) ===
      null,
  );

  await prisma.serviceRequest.update({
    where: { id: request.id },
    data: {
      description: joinRequestDescription("Changed later", {
        answers: [
          {
            catalogItemId: "slab-service",
            contentsHandling: "heavy",
            contentsProtection: "heavy",
            belongingsCleanup: "heavy",
          },
        ],
      }),
    },
  });
  const afterIntakeChange = await loadEstimateDocumentForBusiness(
    estimate.id,
    business.id,
    prisma,
  );
  check(
    "historical SENT snapshot does not pick up later intake wording",
    afterIntakeChange?.projectConditions?.body.includes("reasonably clear") === true &&
      afterIntakeChange?.projectConditions?.body.includes("Heavy moving") !== true,
  );

  console.log("\nTEST — Cleaning estimate terms and calculator merge");
  const cleaningEstimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      status: "DRAFT",
      total: new Prisma.Decimal(150),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: cleaningEstimate.id,
      description: joinLineDescription("Move-out cleaning", "Clean kitchen and baths."),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(150),
      total: new Prisma.Decimal(150),
      type: "LABOR",
    },
  });
  const cleaningDoc = await loadEstimateDocumentForBusiness(
    cleaningEstimate.id,
    business.id,
    prisma,
  );
  check(
    "cleaning draft gets cleaning terms without construction concealed-condition dump",
    hasTitle(cleaningDoc?.terms ?? [], "Cleaning Access & Utilities") &&
      hasTitle(cleaningDoc?.terms ?? [], "Cleaning Scope Limits") &&
      !hasTitle(cleaningDoc?.terms ?? [], "Unforeseen / Concealed Conditions") &&
      !hasTitle(cleaningDoc?.terms ?? [], "Construction / Renovation Conditions") &&
      cleaningDoc?.projectConditions == null,
  );

  const panelEstimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      status: "DRAFT",
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const panelLine = await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: panelEstimate.id,
      description: joinLineDescription(
        DECORATIVE_WALL_PANELING_TITLE,
        "Install paneling",
        null,
        [
          {
            id: "core-scope-of-work",
            title: "Scope of Work",
            body: "Keep this core term.",
            family: "core",
          },
        ],
      ),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  const applied = await applyDraftEstimateCalculator(prisma, ownerAccess, {
    estimateId: panelEstimate.id,
    lineItemId: panelLine.id,
    inputs: FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
    customerPolicies: [
      {
        id: "work-area-personal-property",
        title: "Work Area & Personal Property",
        body: "Calculator work-area wording.",
      },
    ],
  });
  const afterApply = lineCustomerPolicies(applied.description);
  check(
    "applying the calculator keeps stamped core terms and merges work-area",
    hasTitle(afterApply, "Scope of Work") &&
      afterApply.find((policy) => policy.id === "core-scope-of-work")?.body ===
        "Keep this core term." &&
      afterApply.find((policy) => policy.id === "work-area-personal-property")
        ?.body === "Calculator work-area wording.",
  );

  const historical = await prisma.estimate.create({
    data: {
      businessId: business.id,
      status: "DRAFT",
      total: new Prisma.Decimal(100),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: historical.id,
      description: joinLineDescription("Old repair", "Fix the latch."),
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(100),
      total: new Prisma.Decimal(100),
      type: "LABOR",
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.estimate.updateMany({
      where: { id: historical.id, businessId: business.id, status: "DRAFT" },
      data: { status: "SENT" },
    });
    await createEstimateVersionSnapshot(tx, {
      estimateId: historical.id,
      businessId: business.id,
    });
  });
  const historicalDoc = await loadEstimateDocumentForBusiness(
    historical.id,
    business.id,
    prisma,
  );
  check(
    "historical SENT estimates without stamped terms stay unchanged",
    historicalDoc?.terms.length === 0 && historicalDoc?.projectConditions == null,
  );

  await stampDraftEstimateTerms(prisma, {
    estimateId: estimate.id,
    businessId: business.id,
    policies: [
      {
        id: "core-scope-of-work",
        title: "Scope of Work",
        body: "Should not rewrite SENT.",
        family: "core",
      },
    ],
  });
  const sentReread = await loadEstimateDocumentForBusiness(
    estimate.id,
    business.id,
    prisma,
  );
  check(
    "stamp is a no-op on SENT estimates",
    sentReread?.terms.find((term) => term.title === "Scope of Work")?.body !==
      "Should not rewrite SENT.",
  );
} finally {
  await prisma.$disconnect();
}

console.log(
  failed === 0
    ? `\nAll estimate-terms checks passed (${passed}).`
    : `\n${failed} estimate-terms check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
