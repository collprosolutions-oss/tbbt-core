/**
 * Customer work-area intake → request → calculator prefill.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-work-area-intake.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { createPublicServiceRequest } = await import("@/lib/public-intake");
const { submitPublicIntakeForm, runPublicRequestSubmit } = await import(
  "@/lib/public-request-submit"
);
const { putPublicRequestPhotoFromBytes } = await import(
  "@/lib/business-storage/request-photos"
);
const { MemoryStorageProvider } = await import("@/lib/business-storage/index");
const { toPublicCatalogItem } = await import("@/lib/public-site");
const {
  buildEstimateLineCreatesFromRequestItems,
} = await import("@/lib/request-estimate-draft");
const { persistDraftEstimateTotal } = await import("@/lib/labor-minimum");
const {
  applyDraftEstimateCalculator,
} = await import("@/lib/estimate-line-ops");
const {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_TEMPLATE,
  DECORATIVE_WALL_PANELING_TITLE,
  DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  DEFAULT_CONTENTS_HANDLING_RATES,
  FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
  formCalculatorInputs,
  startingCalculatorSnapshot,
} = await import("@/lib/estimate-calculators");
const {
  joinCatalogDescription,
  lineCalculatorSnapshot,
  lineItemIncludedWork,
} = await import("@/lib/estimate-line-scope");
const { customQuoteDisplayDescription } = await import("@/lib/request-estimate-draft");
const {
  WORK_AREA_INTAKE_CLARIFICATION,
  WORK_AREA_INTAKE_MARKER,
  INTAKE_SUBMISSION_MARKER,
  calculatorAsksWorkAreaIntake,
  catalogAsksWorkAreaIntake,
  joinRequestDescription,
  parseIntakeSubmissionId,
  parseWorkAreaFormAnswers,
  parseWorkAreaIntake,
  requestNotesText,
  workAreaIntakeToCalculatorInputs,
} = await import("@/lib/work-area-intake");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
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

const CUSTOM_WITH_WORK_AREA = {
  calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  title: "Custom Opening Work",
  intake: { workArea: true },
  components: [
    {
      key: "openings",
      name: "Openings",
      inputType: "count",
      units: "each",
      quantityKey: "openingCount",
      rateKey: "openingRate",
      defaultRate: 45,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "counts",
    },
    {
      key: "contentsHandling",
      name: "Contents handling",
      inputType: "rate",
      units: "usd",
      quantityKey: "contentsHandlingLevel",
      rateKey: "contentsHandlingLightRate",
      defaultRate: 85,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "allowances",
    },
    {
      key: "contentsProtection",
      name: "Contents protection",
      inputType: "rate",
      units: "usd",
      quantityKey: "contentsProtectionLevel",
      rateKey: "contentsProtectionLightRate",
      defaultRate: 55,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "allowances",
    },
    {
      key: "belongingsCleanup",
      name: "Belongings cleanup",
      inputType: "rate",
      units: "usd",
      quantityKey: "belongingsCleanupLevel",
      rateKey: "belongingsCleanupLightRate",
      defaultRate: 45,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "allowances",
    },
  ],
};

const CUSTOM_WITHOUT_WORK_AREA = {
  calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  title: "Opening Cut-Outs",
  components: [
    {
      key: "openings",
      name: "Openings",
      inputType: "count",
      units: "each",
      quantityKey: "openingCount",
      rateKey: "openingRate",
      defaultRate: 45,
      persistRate: true,
      resetQuantity: true,
      customerVisible: false,
      section: "counts",
    },
  ],
};

console.log("\nSTATIC — Customer intake, owner display, no new column");
const schema = readRepo("prisma/schema.prisma");
const intakeFields = readRepo("src/components/public/request-work-area-fields.tsx");
const requestFlow = readRepo("src/components/public/request-flow.tsx");
const publicIntake = readRepo("src/lib/public-intake.ts");
const publicSite = readRepo("src/lib/public-site.ts");
const customerPage = readRepo("src/app/e/[token]/page.tsx");
const requestsPage = readRepo("src/app/(app)/requests/page.tsx");
const requestsWorkspace = readRepo("src/components/requests/requests-workspace.tsx");
const estimatePage = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const lineOps = readRepo("src/lib/estimate-line-ops.ts");

check(
  "No Prisma work-area intake column — Preview cannot migrate a new field",
  !schema.includes("workAreaIntake") &&
    !schema.includes("contentsHandling") &&
    schema.includes("description"),
);
const intakeLib = readRepo("src/lib/work-area-intake.ts");
check(
  "Customer intake asks the three work-area questions without rates",
  intakeLib.includes("Work area clear / ready") &&
    intakeLib.includes("Light contents moving needed") &&
    intakeLib.includes("No contractor protection required") &&
    intakeLib.includes("Not included / not required") &&
    intakeFields.includes("reasonably clear and accessible") &&
    intakeFields.includes("Ordinary construction cleanup") &&
    intakeFields.includes("WORK_AREA_INTAKE_CLARIFICATION") &&
    intakeLib.includes(WORK_AREA_INTAKE_CLARIFICATION) &&
    !intakeFields.includes("panelRate") &&
    !intakeFields.includes("contentsHandlingLightRate") &&
    !intakeLib.includes("contentsHandlingLightRate"),
);
check(
  "Public request flow collects, validates, reviews, and submits work-area answers",
  requestFlow.includes("RequestWorkAreaFields") &&
    requestFlow.includes("ReviewWorkAreaSummary") &&
    requestFlow.includes("validateWorkAreaIntakeAnswer") &&
    requestFlow.includes("workArea"),
);
check(
  "Customer-facing catalog flag is a boolean and never includes rates",
  publicSite.includes("asksWorkAreaIntake: boolean") &&
    publicSite.includes("catalogAsksWorkAreaIntake(item.description, item.name)") &&
    !publicSite.includes("contentsHandlingLightRate"),
);
check(
  "Public intake stores answers on the request and requires them only when enabled",
  publicIntake.includes("joinRequestDescription") &&
    publicIntake.includes("catalogAsksWorkAreaIntake(catalog.description, catalog.name)"),
);
check(
  "Owner request and estimate pages show labels, not encoded JSON or rates",
  requestsPage.includes("requestNotesText") &&
    requestsPage.includes("formatWorkAreaIntakeLabels") &&
    requestsWorkspace.includes("Customer work-area answers") &&
    estimatePage.includes("Customer work-area answers") &&
    estimatePage.includes("formCalculatorInputs") &&
    !customerPage.includes("RequestWorkAreaFields") &&
    !customerPage.includes("contentsHandlingLightRate") &&
    !customerPage.includes("VariableScopeCalculatorForm"),
);
check(
  "Owner calculator apply updates the draft line, not the customer request",
  lineOps.includes("export async function applyDraftEstimateCalculator") &&
    !lineOps
      .slice(lineOps.indexOf("export async function applyDraftEstimateCalculator"))
      .includes("serviceRequest.update"),
);
check(
  "Submit Request always clears pending and catches a thrown server action",
  requestFlow.includes("submitPublicIntakeForm") &&
    requestFlow.includes("finally") &&
    requestFlow.includes("setPending(false)") &&
    requestFlow.includes("submissionId") &&
    readRepo("src/app/actions/intake.ts").includes("submitServiceRequestInner") &&
    readRepo("src/app/actions/intake.ts").includes("return { error: GENERIC_ERROR }"),
);
check(
  "Photo uploads still use the existing presigned R2 PUT and abort before submit on failure",
  requestFlow.includes("authorizePublicRequestPhotoUpload") &&
    requestFlow.includes("authorized.uploadUrl") &&
    requestFlow.indexOf("if (!uploaded.ok)") <
      requestFlow.lastIndexOf("submitPublicIntakeForm") &&
    requestFlow.includes("abortPublicRequestPhotoUpload") &&
    readRepo("src/lib/business-storage/r2-cors.ts").includes(
      "https://collpro-reno-git-cursor-estimate-pri-d221ac-collpro-s-projects5.vercel.app",
    ),
);

console.log("\nUNIT — Applicability, encoding, and calculator prefill");
check(
  "Decorative Wall Paneling template enables work-area intake",
  calculatorAsksWorkAreaIntake(DECORATIVE_WALL_PANELING_TEMPLATE) === true,
);
check(
  "Starter paneling catalog item enables intake from its title before a definition is saved",
  catalogAsksWorkAreaIntake(
    "Installation of decorative wall paneling.",
    DECORATIVE_WALL_PANELING_TITLE,
  ) === true,
);
check(
  "Custom variable-scope with the three work-area quantity keys enables intake",
  calculatorAsksWorkAreaIntake(CUSTOM_WITH_WORK_AREA) === true,
);
check(
  "Custom variable-scope without work-area quantity keys does not enable intake",
  calculatorAsksWorkAreaIntake(CUSTOM_WITHOUT_WORK_AREA) === false &&
    catalogAsksWorkAreaIntake(
      joinCatalogDescription("Cut openings", {
        calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
        rates: { openingRate: 45 },
        components: CUSTOM_WITHOUT_WORK_AREA.components,
      }),
      "Opening Cut-Outs",
    ) === false,
);
check(
  "Explicit intake.workArea=false disables questions even when quantity keys exist",
  calculatorAsksWorkAreaIntake({
    ...CUSTOM_WITH_WORK_AREA,
    intake: { workArea: false },
  }) === false,
);
check(
  "Services without a variable-scope work-area definition do not ask",
  catalogAsksWorkAreaIntake(null, "Blind / Shade Installation") === false &&
    catalogAsksWorkAreaIntake("Install a standard blind.", "Ceiling Fan Replacement") ===
      false,
);

const notes = "Please use the side gate.";
const intakeRecord = {
  answers: [
    {
      catalogItemId: "panel-1",
      contentsHandling: "light",
      contentsProtection: "none",
      belongingsCleanup: "none",
    },
  ],
};
const stored = joinRequestDescription(notes, intakeRecord);
check(
  "Request notes stay readable and the encoded answers stay parseable",
  requestNotesText(stored) === notes &&
    stored.includes(WORK_AREA_INTAKE_MARKER) &&
    parseWorkAreaIntake(stored)?.answers[0]?.contentsHandling === "light",
);

const prefill = startingCalculatorSnapshot({
  title: DECORATIVE_WALL_PANELING_TITLE,
  prefillInputs: workAreaIntakeToCalculatorInputs(intakeRecord.answers[0]),
});
check(
  "Customer light contents-moving prefills the owner calculator selection",
  prefill?.inputs.contentsHandlingLevel === "light" &&
    prefill?.inputs.contentsProtectionLevel === "none" &&
    prefill?.inputs.belongingsCleanupLevel === "none" &&
    prefill?.inputs.wallWidthFt === 0,
);
check(
  "Prefill uses saved business rates, not a customer-chosen price",
  prefill?.rates.contentsHandlingLightRate ===
    DEFAULT_DECORATIVE_WALL_PANELING_RATES.contentsHandlingLightRate &&
    prefill?.rates.contentsHandlingLightRate === DEFAULT_CONTENTS_HANDLING_RATES.light &&
    prefill?.appliedAmount == null,
);
const unappliedForm = formCalculatorInputs({
  calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  snapshot: prefill,
  rates: prefill?.rates,
});
check(
  "Unapplied owner form keeps the customer work-area selections",
  unappliedForm.contentsHandlingLevel === "light" &&
    unappliedForm.contentsProtectionLevel === "none",
);

const publicItem = toPublicCatalogItem({
  id: "panel-1",
  name: DECORATIVE_WALL_PANELING_TITLE,
  description: joinCatalogDescription("Install decorative wall paneling.", {
    calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
    intake: { workArea: true },
  }),
  category: "Trim & Carpentry",
  pricingMode: "CUSTOM_QUOTE",
  price: null,
});
const formAnswers = parseWorkAreaFormAnswers([
  JSON.stringify({
    catalogItemId: "panel-1",
    contentsHandling: "light",
    contentsProtection: "none",
    belongingsCleanup: "none",
  }),
  "not-json",
]);
check(
  "Work-area FormData JSON is parsed into validated answers",
  formAnswers.length === 1 && formAnswers[0].contentsHandling === "light",
);

const storedWithSubmission = joinRequestDescription(notes, intakeRecord, "submit-token-123");
check(
  "Submission token is stored without breaking work-area JSON parse",
  parseWorkAreaIntake(storedWithSubmission)?.answers[0]?.contentsHandling === "light" &&
    parseIntakeSubmissionId(storedWithSubmission) === "submit-token-123" &&
    requestNotesText(storedWithSubmission) === notes &&
    storedWithSubmission.includes(INTAKE_SUBMISSION_MARKER),
);

const thrownSubmit = await submitPublicIntakeForm(async () => {
  throw new Error("server action digest");
}, "collpro-reno", new FormData());
const failedSubmit = await submitPublicIntakeForm(async () => {
  return { error: "Please answer the work-area questions for the selected work." };
}, "collpro-reno", new FormData());
const okSubmit = await submitPublicIntakeForm(async () => {
  return { ok: true };
}, "collpro-reno", new FormData());
let pendingFlag = true;
const pendingAfterThrow = await (async () => {
  pendingFlag = true;
  try {
    const result = await submitPublicIntakeForm(async () => {
      throw new Error("hung action");
    }, "collpro-reno", new FormData());
    return result;
  } finally {
    pendingFlag = false;
  }
})();
check("Thrown server action becomes a retryable error instead of hanging", thrownSubmit.ok === false);
check("Returned validation errors stay visible to the customer", failedSubmit.ok === false);
check("Successful submit returns ok", okSubmit.ok === true);
check(
  "Failure state clears pending UI",
  pendingAfterThrow.ok === false && pendingFlag === false,
);

const runFailed = await runPublicRequestSubmit(async () => {
  throw new Error("boom");
});
check("runPublicRequestSubmit clears a thrown submit without a value", runFailed.ok === false);

check(
  "Public catalog item can enable intake without exposing internal rates",
  publicItem.asksWorkAreaIntake === true &&
    publicItem.description?.includes("Install decorative wall paneling") === true &&
    !JSON.stringify(publicItem).includes("contentsHandlingLightRate") &&
    !JSON.stringify(publicItem).includes("panelRate") &&
    !JSON.stringify(publicItem).includes("TBBT Calculator"),
);

const testDbName = `tbbt_work_area_intake_${randomUUID().slice(0, 8)}`;
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
  console.error("Failed to push schema for work-area intake test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

try {
  console.log("\nDB — Intake → request → calculator prefill, owner override, preservation");
  const slug = `work-area-${randomUUID().slice(0, 8)}`;
  const business = await prisma.business.create({
    data: { name: "Work Area Intake Co", slug, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: {
      name: "Owner",
      email: `owner-intake-${randomUUID()}@example.com`,
      passwordHash: "x",
    },
  });
  const membership = await prisma.membership.create({
    data: { businessId: business.id, userId: ownerUser.id, role: "OWNER" },
  });
  const owner = makeAccess(business.id, "OWNER", membership.id);

  const paneling = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: DECORATIVE_WALL_PANELING_TITLE,
      category: "Trim & Carpentry",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
      description: joinCatalogDescription(
        "Installation of decorative wall paneling.",
        {
          calculatorId: DECORATIVE_WALL_PANELING_CALCULATOR_ID,
          rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
          intake: { workArea: true },
        },
      ),
    },
  });
  const blinds = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Blind / Shade Installation",
      category: "Mounting & Hanging",
      pricingMode: "STARTING_AT",
      price: new Prisma.Decimal(85),
      active: true,
      intakeMeasurementMode: "RECOMMENDED",
      intakeMeasurementAxes: "width,height",
      intakeMeasurementUnit: "IN",
    },
  });
  const customEnabled = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Custom Opening Work",
      category: "Trim & Carpentry",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
      description: joinCatalogDescription("Cut and finish openings.", {
        calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
        rates: {
          openingRate: 45,
          contentsHandlingLightRate: 85,
          contentsProtectionLightRate: 55,
          belongingsCleanupLightRate: 45,
        },
        components: CUSTOM_WITH_WORK_AREA.components,
        intake: { workArea: true },
      }),
    },
  });
  const customDisabled = await prisma.serviceCatalogItem.create({
    data: {
      businessId: business.id,
      name: "Opening Cut-Outs",
      category: "Trim & Carpentry",
      pricingMode: "CUSTOM_QUOTE",
      price: null,
      active: true,
      description: joinCatalogDescription("Cut openings only.", {
        calculatorId: CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
        rates: { openingRate: 45 },
        components: CUSTOM_WITHOUT_WORK_AREA.components,
      }),
    },
  });

  const missing = await createPublicServiceRequest(prisma, {
    slug,
    name: "Missing Answers",
    email: "missing@example.com",
    phone: "555-0100",
    address: "",
    streetAddress: "10 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Need paneling.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
  });
  check(
    "Enabled service rejects a request that omits work-area answers",
    missing.ok === false,
  );

  const blindsOnly = await createPublicServiceRequest(prisma, {
    slug,
    name: "Blinds Customer",
    email: "blinds@example.com",
    phone: "555-0101",
    address: "",
    streetAddress: "11 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Two windows.",
    catalogItemIds: [blinds.id],
    includeOther: false,
    otherDescription: "",
    measurements: [{ catalogItemId: blinds.id, width: "32", height: "48", unit: "IN" }],
  });
  const blindsRequest = blindsOnly.ok
    ? await prisma.serviceRequest.findUnique({ where: { id: blindsOnly.requestId } })
    : null;
  check("Service without work-area intake still submits", blindsOnly.ok === true);
  check(
    "Disabled intake does not store work-area answers",
    parseWorkAreaIntake(blindsRequest?.description) == null &&
      requestNotesText(blindsRequest?.description) === "Two windows.",
  );

  const customOff = await createPublicServiceRequest(prisma, {
    slug,
    name: "Cut Outs Customer",
    email: "cutouts@example.com",
    phone: "555-0102",
    address: "",
    streetAddress: "12 Oak St",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Three openings.",
    catalogItemIds: [customDisabled.id],
    includeOther: false,
    otherDescription: "",
  });
  check(
    "Custom variable-scope without work-area keys does not require intake answers",
    customOff.ok === true &&
      parseWorkAreaIntake(
        (await prisma.serviceRequest.findUnique({ where: { id: customOff.requestId } }))
          ?.description,
      ) == null,
  );

  const originalNotes = "Please use the side gate.";
  const submitted = await createPublicServiceRequest(prisma, {
    slug,
    name: "Paneling Customer",
    email: "panel@example.com",
    phone: "555-0103",
    address: "",
    streetAddress: "24 Harbor",
    city: "Cape Coral",
    region: "FL",
    postalCode: "33904",
    notes: originalNotes,
    catalogItemIds: [paneling.id, customEnabled.id],
    includeOther: false,
    otherDescription: "",
    workAreaAnswers: [
      {
        catalogItemId: paneling.id,
        contentsHandling: "light",
        contentsProtection: "none",
        belongingsCleanup: "none",
      },
      {
        catalogItemId: customEnabled.id,
        contentsHandling: "moderate",
        contentsProtection: "light",
        belongingsCleanup: "heavy",
      },
    ],
  });
  const request = submitted.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: submitted.requestId },
        include: {
          items: { include: { serviceCatalogItem: true }, orderBy: { sortOrder: "asc" } },
        },
      })
    : null;
  const storedIntake = parseWorkAreaIntake(request?.description);
  check("Customer intake stores work-area answers on the request", submitted.ok === true);
  check(
    "Customer notes stay separate from encoded intake JSON",
    requestNotesText(request?.description) === originalNotes &&
      request?.description?.includes(WORK_AREA_INTAKE_MARKER) === true,
  );
  check(
    "Stored answers keep the customer's light / none / none paneling selections",
    storedIntake?.answers.find((answer) => answer.catalogItemId === paneling.id)
      ?.contentsHandling === "light" &&
      storedIntake?.answers.find((answer) => answer.catalogItemId === paneling.id)
        ?.contentsProtection === "none" &&
      storedIntake?.answers.find((answer) => answer.catalogItemId === paneling.id)
        ?.belongingsCleanup === "none",
  );

  const lineCreates = buildEstimateLineCreatesFromRequestItems(
    business.id,
    request.items,
    storedIntake,
  );
  const panelingLineCreate = lineCreates.find(
    (line) => line.serviceCatalogItemId === paneling.id,
  );
  const customLineCreate = lineCreates.find(
    (line) => line.serviceCatalogItemId === customEnabled.id,
  );
  const panelingSnapshot = lineCalculatorSnapshot(panelingLineCreate?.description);
  const customSnapshot = lineCalculatorSnapshot(customLineCreate?.description);
  check(
    "Estimate draft prefills paneling calculator from the customer request",
    panelingSnapshot?.inputs.contentsHandlingLevel === "light" &&
      panelingSnapshot?.inputs.contentsProtectionLevel === "none" &&
      panelingSnapshot?.inputs.belongingsCleanupLevel === "none" &&
      panelingSnapshot?.rates.contentsHandlingLightRate ===
        DEFAULT_CONTENTS_HANDLING_RATES.light,
  );
  check(
    "Reusable custom variable-scope also prefills work-area levels from intake",
    customSnapshot?.inputs.contentsHandlingLevel === "moderate" &&
      customSnapshot?.inputs.contentsProtectionLevel === "light" &&
      customSnapshot?.inputs.belongingsCleanupLevel === "heavy",
  );
  check(
    "Customer-facing draft title and scope do not expose rates or intake JSON",
    customQuoteDisplayDescription(panelingLineCreate?.description ?? "") ===
      DECORATIVE_WALL_PANELING_TITLE &&
      !lineItemIncludedWork(panelingLineCreate?.description)?.includes(
        "contentsHandlingLightRate",
      ) &&
      !lineItemIncludedWork(panelingLineCreate?.description)?.includes(
        WORK_AREA_INTAKE_MARKER,
      ),
  );

  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      serviceRequestId: request.id,
      total: new Prisma.Decimal(0),
      publicToken: randomUUID(),
    },
  });
  const line = await prisma.lineItem.create({
    data: {
      businessId: business.id,
      estimateId: estimate.id,
      serviceCatalogItemId: paneling.id,
      description: panelingLineCreate.description,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      type: "LABOR",
    },
  });
  await persistDraftEstimateTotal(prisma, estimate.id, business.id);

  const applied = await applyDraftEstimateCalculator(prisma, owner, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: {
      ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
      contentsHandlingLevel: "light",
      contentsProtectionLevel: "none",
      belongingsCleanupLevel: "none",
    },
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });
  check(
    "Saved light contents-handling rate is applied when the customer selected Light",
    applied.unitPrice.toString() ===
      String(1800 + DEFAULT_CONTENTS_HANDLING_RATES.light) &&
      lineCalculatorSnapshot(applied.description)?.inputs.contentsHandlingLevel ===
        "light",
  );

  const overridden = await applyDraftEstimateCalculator(prisma, owner, {
    estimateId: estimate.id,
    lineItemId: line.id,
    inputs: {
      ...FOUNDER_DECORATIVE_WALL_PANELING_EXAMPLE,
      contentsHandlingLevel: "moderate",
      contentsProtectionLevel: "none",
      belongingsCleanupLevel: "none",
    },
    rates: DEFAULT_DECORATIVE_WALL_PANELING_RATES,
  });
  check(
    "Owner can change the contents-handling level and recalculate with the saved moderate rate",
    overridden.unitPrice.toString() ===
      String(1800 + DEFAULT_CONTENTS_HANDLING_RATES.moderate) &&
      lineCalculatorSnapshot(overridden.description)?.inputs.contentsHandlingLevel ===
        "moderate",
  );

  const requestAfterOverride = await prisma.serviceRequest.findUnique({
    where: { id: request.id },
  });
  const intakeAfterOverride = parseWorkAreaIntake(requestAfterOverride?.description);
  check(
    "Owner override does not rewrite the customer's original request answers",
    requestNotesText(requestAfterOverride?.description) === originalNotes &&
      intakeAfterOverride?.answers.find((answer) => answer.catalogItemId === paneling.id)
        ?.contentsHandling === "light" &&
      intakeAfterOverride?.answers.find((answer) => answer.catalogItemId === paneling.id)
        ?.contentsProtection === "none",
  );
  check(
    "Saved business rates stay on the calculator after the owner changes the job selection",
    lineCalculatorSnapshot(overridden.description)?.rates.contentsHandlingLightRate ===
      DEFAULT_CONTENTS_HANDLING_RATES.light &&
      lineCalculatorSnapshot(overridden.description)?.rates.contentsHandlingModerateRate ===
        DEFAULT_CONTENTS_HANDLING_RATES.moderate,
  );

  console.log("\nDB — Submit Request payload, photos, and no-duplicate retry");
  const workAreaPayload = parseWorkAreaFormAnswers([
    JSON.stringify({
      catalogItemId: paneling.id,
      contentsHandling: "moderate",
      contentsProtection: "light",
      belongingsCleanup: "none",
    }),
  ]);
  const noPhotoSubmit = await createPublicServiceRequest(prisma, {
    slug,
    name: "No Photo Submit",
    email: "nophoto-submit@example.com",
    phone: "555-0200",
    address: "",
    streetAddress: "100 Pine",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "No photos attached.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
    workAreaAnswers: workAreaPayload,
    submissionId: "retry-token-no-photos",
  });
  const noPhotoRequest = noPhotoSubmit.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: noPhotoSubmit.requestId },
        include: { photos: true },
      })
    : null;
  check("Decorative Wall Paneling request with work-area answers and no photos succeeds", noPhotoSubmit.ok === true);
  check(
    "Work-area answers persist on the no-photo request",
    parseWorkAreaIntake(noPhotoRequest?.description)?.answers[0]?.contentsHandling ===
      "moderate" && noPhotoRequest?.photos.length === 0,
  );
  const noPhotoRetry = await createPublicServiceRequest(prisma, {
    slug,
    name: "No Photo Submit",
    email: "nophoto-submit@example.com",
    phone: "555-0200",
    address: "",
    streetAddress: "100 Pine",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "No photos attached.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
    workAreaAnswers: workAreaPayload,
    submissionId: "retry-token-no-photos",
  });
  const noPhotoCount = await prisma.serviceRequest.count({
    where: { businessId: business.id, description: { contains: "retry-token-no-photos" } },
  });
  check(
    "Retrying the same no-photo submit does not create a duplicate request",
    noPhotoRetry.ok === true &&
      noPhotoRetry.requestId === noPhotoSubmit.requestId &&
      noPhotoCount === 1,
  );

  const pngBytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
    "hex",
  );
  const provider = new MemoryStorageProvider();
  const storageDeps = {
    db: prisma,
    provider,
    bucketName: "tbbt-request-photos",
  };
  const firstPhoto = await putPublicRequestPhotoFromBytes(storageDeps, slug, {
    originalFilename: "wall-1.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const onePhotoSubmit = await createPublicServiceRequest(prisma, {
    slug,
    name: "One Photo Submit",
    email: "one-photo-submit@example.com",
    phone: "555-0202",
    address: "",
    streetAddress: "150 Pine",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "One photo attached.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
    workAreaAnswers: workAreaPayload,
    photoAssetIds: [firstPhoto.id],
    submissionId: "retry-token-one-photo",
  });
  const onePhotoRequest = onePhotoSubmit.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: onePhotoSubmit.requestId },
        include: { photos: true },
      })
    : null;
  check(
    "Decorative Wall Paneling request with work-area answers and one photo succeeds",
    onePhotoSubmit.ok === true &&
      onePhotoRequest?.photos.length === 1 &&
      parseWorkAreaIntake(onePhotoRequest?.description)?.answers[0]?.belongingsCleanup ===
        "none",
  );
  const secondPhoto = await putPublicRequestPhotoFromBytes(storageDeps, slug, {
    originalFilename: "wall-2.png",
    mimeType: "image/png",
    body: pngBytes,
  });
  const withPhotosSubmit = await createPublicServiceRequest(prisma, {
    slug,
    name: "Photo Submit",
    email: "photos-submit@example.com",
    phone: "555-0201",
    address: "",
    streetAddress: "200 Pine",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Two photos attached.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
    workAreaAnswers: workAreaPayload,
    photoAssetIds: [firstPhoto.id, secondPhoto.id],
    submissionId: "retry-token-with-photos",
  });
  const photoRequest = withPhotosSubmit.ok
    ? await prisma.serviceRequest.findUnique({
        where: { id: withPhotosSubmit.requestId },
        include: { photos: true },
      })
    : null;
  check("Decorative Wall Paneling request with work-area answers and multiple photos succeeds", withPhotosSubmit.ok === true);
  check(
    "Photos still attach when present",
    photoRequest?.photos.length === 2 &&
      parseWorkAreaIntake(photoRequest?.description)?.answers[0]?.contentsProtection ===
        "light",
  );
  const photoRetry = await createPublicServiceRequest(prisma, {
    slug,
    name: "Photo Submit",
    email: "photos-submit@example.com",
    phone: "555-0201",
    address: "",
    streetAddress: "200 Pine",
    city: "Fort Myers",
    region: "FL",
    postalCode: "33901",
    notes: "Two photos attached.",
    catalogItemIds: [paneling.id],
    includeOther: false,
    otherDescription: "",
    workAreaAnswers: workAreaPayload,
    photoAssetIds: [firstPhoto.id, secondPhoto.id],
    submissionId: "retry-token-with-photos",
  });
  const photoCount = await prisma.serviceRequest.count({
    where: { businessId: business.id, description: { contains: "retry-token-with-photos" } },
  });
  check(
    "Retrying the same photo submit does not create a duplicate request",
    photoRetry.ok === true &&
      photoRetry.requestId === withPhotosSubmit.requestId &&
      photoCount === 1 &&
      (await prisma.serviceRequestPhoto.count({
        where: { serviceRequestId: withPhotosSubmit.requestId },
      })) === 2,
  );
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
    ? `\nAll work-area intake checks passed (${passed}).`
    : `\n${failed} work-area intake check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
