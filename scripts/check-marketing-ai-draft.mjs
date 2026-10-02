/**
 * OWNER Marketing Studio AI content draft — fake provider + isolation.
 *
 * No live AI call. The canonical provider is injected with a fake
 * adapter for the connected path. Unavailable is shown when the
 * provider is not configured.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-marketing-ai-draft.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const {
  MARKETING_AI_DRAFT_REVIEW_ONLY_MESSAGE,
  MARKETING_AI_DRAFT_SAVED_MESSAGE,
  MARKETING_AI_UNAVAILABLE_LABEL,
  OWNER_MARKETING_AI_DRAFT_MESSAGE,
  marketingAiDraftStatusLabel,
} = await import("@/lib/marketing");
const { MarketingError } = await import("@/lib/marketing-ops");
const { requestOwnerMarketingContentDraft } = await import("@/lib/marketing-ai-draft");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

// Never call a live model from this check. Connected proofs inject a fake.
delete process.env.TBBT_AI_API_KEY;
delete process.env.OPENAI_API_KEY;

const testDbName = "tbbt_marketing_ai_draft_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";
const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
  console.warn(createDb.stderr || createDb.stdout);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for marketing AI draft test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

async function expectError(label, fn, predicate) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${userId}@example.test`, name: role },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

function readSrc(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function createFakeProvider(calls) {
  return {
    id: "fake",
    connected: true,
    async complete(request) {
      calls.push(request);
      const parsed = JSON.parse(request.user);
      return {
        ok: true,
        provider: "fake",
        model: "fake-test",
        text: JSON.stringify({
          text: `Reviewable draft for ${parsed.businessName} about ${parsed.workPerformed || "recorded work"}.`,
          stance: "RECOMMENDATION",
          citedFactKeys: ["workPerformed", "businessName"],
          notes: "Fake provider test. Remains DRAFT.",
        }),
        latencyMs: 1,
      };
    },
  };
}

try {
  console.log("\nSTATIC — Marketing AI draft wiring");
  const draftSrc = readSrc("src/lib/marketing-ai-draft.ts");
  const providerSrc = readSrc("src/lib/ai/provider.ts");
  const actionSrc = readSrc("src/app/actions/marketing.ts");
  const panelSrc = readSrc("src/components/marketing/generate-ai-panel.tsx");
  const dataSrc = readSrc("src/lib/marketing-data.ts");

  check("Unavailable label is exact", MARKETING_AI_UNAVAILABLE_LABEL === "Unavailable");
  check("Disconnected status label is Unavailable", marketingAiDraftStatusLabel(false) === "Unavailable");
  check("Configured status label is Connected", marketingAiDraftStatusLabel(true) === "Connected");
  check("Canonical resolver stays none-or-openai", providerSrc.includes("DisconnectedAiProvider") && providerSrc.includes("OpenAiCompatibleProvider") && !providerSrc.includes("FakeAi"));
  check(
    "OWNER request uses runAiTask and resolveAiProvider",
    draftSrc.includes("runAiTask") &&
      draftSrc.includes("resolveAiProvider") &&
      draftSrc.includes('taskType: "MARKETING_DRAFT"') &&
      draftSrc.includes("createMarketingContent"),
  );
  check(
    "Draft path does not add a second provider or duplicate template drafts",
    !draftSrc.includes("draftMarketingContent(") &&
      !draftSrc.includes("draftMarketingVariations") &&
      !draftSrc.includes("draftMarketingStudioPackage") &&
      !draftSrc.includes("OpenAiCompatibleProvider") &&
      !draftSrc.includes("class ") &&
      !draftSrc.includes("api.openai.com"),
  );
  check(
    "Draft path never publishes, posts, or messages customers",
    !draftSrc.includes("websitePublish") &&
      !draftSrc.includes("publishWebsite") &&
      !draftSrc.includes("customer-messaging") &&
      !draftSrc.includes("sendMessage") &&
      !draftSrc.includes("social") &&
      draftSrc.includes("publishable: false") &&
      MARKETING_AI_DRAFT_REVIEW_ONLY_MESSAGE.includes("will not publish"),
  );
  check(
    "Page load stays template-only",
    !dataSrc.includes("WithAi") &&
      !dataSrc.includes("runAiTask") &&
      !dataSrc.includes("requestOwnerMarketingContentDraft") &&
      dataSrc.includes("marketingAiDraftStatusLabel"),
  );
  check(
    "Studio UI shows Unavailable and one OWNER request",
    panelSrc.includes("MARKETING_AI_UNAVAILABLE_LABEL") &&
      panelSrc.includes("Request content draft") &&
      !panelSrc.includes("Generate AI variations") &&
      !panelSrc.includes("Generate weekly plan") &&
      actionSrc.includes("requestOwnerMarketingContentDraft") &&
      actionSrc.includes("OWNER_MARKETING_AI_DRAFT_MESSAGE"),
  );
  const previousName = process.env.TBBT_MARKETING_AI_PROVIDER;
  const previousKey = process.env.TBBT_AI_API_KEY;
  const previousOpenAi = process.env.OPENAI_API_KEY;
  process.env.TBBT_MARKETING_AI_PROVIDER = "openai";
  delete process.env.TBBT_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  check(
    "A provider name env does not configure the canonical provider",
    marketingAiDraftStatusLabel() === "Unavailable",
  );
  if (previousName == null) delete process.env.TBBT_MARKETING_AI_PROVIDER;
  else process.env.TBBT_MARKETING_AI_PROVIDER = previousName;
  if (previousKey == null) delete process.env.TBBT_AI_API_KEY;
  else process.env.TBBT_AI_API_KEY = previousKey;
  if (previousOpenAi == null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAi;

  const ownerA = await prisma.user.create({
    data: { name: "A Owner", email: `a-mkt-ai-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminAUser = await prisma.user.create({
    data: { name: "A Admin", email: `a-admin-mkt-ai-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberAUser = await prisma.user.create({
    data: { name: "A Member", email: `a-member-mkt-ai-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "B Owner", email: `b-mkt-ai-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Studio",
      slug: `alpha-mkt-ai-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      publicServiceAreaLabel: "Reno",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Studio",
      slug: `beta-mkt-ai-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      publicServiceAreaLabel: "Sparks",
    },
  });
  const memA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  const memAdminA = await prisma.membership.create({
    data: { userId: adminAUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memMemberA = await prisma.membership.create({
    data: { userId: memberAUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const memB = await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });

  const catalogA = await prisma.serviceCatalogItem.create({
    data: { businessId: businessA.id, name: "faucet repair", active: true },
  });
  const catalogB = await prisma.serviceCatalogItem.create({
    data: { businessId: businessB.id, name: "deck repair", active: true },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "A Customer" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "B Customer" },
  });
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      publicToken: randomUUID(),
    },
  });
  const estimateB = await prisma.estimate.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimateA.id,
      serviceCatalogItemId: catalogA.id,
      description: "faucet repair",
      quantity: 1,
      unitPrice: 80,
      total: 80,
      type: "LABOR",
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessB.id,
      estimateId: estimateB.id,
      serviceCatalogItemId: catalogB.id,
      description: "deck repair",
      quantity: 1,
      unitPrice: 80,
      total: 80,
      type: "LABOR",
    },
  });
  await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      estimateId: estimateA.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: customerB.id,
      estimateId: estimateB.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  const ownerAccessA = makeAccess(businessA.id, "OWNER", memA.id, ownerA.id);
  const adminAccessA = makeAccess(businessA.id, "ADMIN", memAdminA.id, adminAUser.id);
  const memberAccessA = makeAccess(businessA.id, "MEMBER", memMemberA.id, memberAUser.id);
  const ownerAccessB = makeAccess(businessB.id, "OWNER", memB.id, ownerB.id);

  console.log("\nDB — Unavailable when the provider is not configured");
  const disconnectedCalls = [];
  const unavailable = await requestOwnerMarketingContentDraft(prisma, ownerAccessA, {
    attemptId: randomUUID(),
  });
  check(
    "Disconnected OWNER request returns Unavailable and stays unpublished",
    unavailable.status === "UNAVAILABLE" &&
      unavailable.message === "Unavailable" &&
      unavailable.publishable === false &&
      unavailable.contentId == null &&
      unavailable.text == null,
  );
  const noneAfterUnavailable = await prisma.marketingContent.count({ where: { businessId: businessA.id } });
  const noneInteractions = await prisma.aiInteraction.count({ where: { businessId: businessA.id } });
  check("Unavailable does not create a content draft", noneAfterUnavailable === 0);
  check("Unavailable does not record an AI interaction", noneInteractions === 0);
  check("Unavailable does not call a provider", disconnectedCalls.length === 0);

  await expectError(
    "ADMIN cannot request an AI content draft",
    () =>
      requestOwnerMarketingContentDraft(prisma, adminAccessA, {
        attemptId: randomUUID(),
        provider: createFakeProvider([]),
      }),
    (error) => error instanceof MarketingError && error.message === OWNER_MARKETING_AI_DRAFT_MESSAGE,
  );
  await expectError(
    "MEMBER cannot request an AI content draft",
    () =>
      requestOwnerMarketingContentDraft(prisma, memberAccessA, {
        attemptId: randomUUID(),
        provider: createFakeProvider([]),
      }),
    (error) => error instanceof ForbiddenError || (error instanceof MarketingError && error.message === OWNER_MARKETING_AI_DRAFT_MESSAGE),
  );
  check(
    "ADMIN/MEMBER denials did not create drafts",
    (await prisma.marketingContent.count({ where: { businessId: businessA.id } })) === 0,
  );

  console.log("\nDB — Fake provider draft + tenant isolation");
  const callsA = [];
  const attemptA = randomUUID();
  const draftA = await requestOwnerMarketingContentDraft(prisma, ownerAccessA, {
    attemptId: attemptA,
    provider: createFakeProvider(callsA),
  });
  check(
    "Fake provider saves a reviewable DRAFT for business A",
    draftA.status === "COMPLETED" &&
      draftA.publishable === false &&
      draftA.message === MARKETING_AI_DRAFT_SAVED_MESSAGE &&
      Boolean(draftA.contentId) &&
      Boolean(draftA.text?.includes("Alpha Studio")) &&
      Boolean(draftA.text?.includes("faucet repair")) &&
      callsA.length === 1 &&
      callsA[0].taskType === "MARKETING_DRAFT",
  );
  const rowA = await prisma.marketingContent.findFirst({
    where: { id: draftA.contentId, businessId: businessA.id },
  });
  check(
    "Saved draft is DRAFT and was not published, posted, or exported",
    rowA?.status === "DRAFT" &&
      rowA.exportedAt == null &&
      rowA.plannedFor == null &&
      rowA.body === draftA.text,
  );

  const retryA = await requestOwnerMarketingContentDraft(prisma, ownerAccessA, {
    attemptId: attemptA,
    provider: createFakeProvider(callsA),
  });
  const aDraftCount = await prisma.marketingContent.count({ where: { businessId: businessA.id } });
  check(
    "Same OWNER attempt does not duplicate the draft or call the fake provider again",
    retryA.contentId === draftA.contentId &&
      aDraftCount === 1 &&
      callsA.length === 1,
  );

  const callsB = [];
  const draftB = await requestOwnerMarketingContentDraft(prisma, ownerAccessB, {
    attemptId: randomUUID(),
    provider: createFakeProvider(callsB),
  });
  check(
    "Fake provider saves a separate DRAFT for business B",
    draftB.status === "COMPLETED" &&
      draftB.contentId !== draftA.contentId &&
      Boolean(draftB.text?.includes("Beta Studio")) &&
      Boolean(draftB.text?.includes("deck repair")) &&
      !draftB.text?.includes("Alpha Studio") &&
      callsB.length === 1,
  );

  const aSeesB = await prisma.marketingContent.findFirst({
    where: { id: draftB.contentId, businessId: businessA.id },
  });
  const bSeesA = await prisma.marketingContent.findFirst({
    where: { id: draftA.contentId, businessId: businessB.id },
  });
  const aInteractionOnB = await prisma.aiInteraction.findFirst({
    where: { id: draftA.interactionId, businessId: businessB.id },
  });
  const bInteractionOnA = await prisma.aiInteraction.findFirst({
    where: { id: draftB.interactionId, businessId: businessA.id },
  });
  check("Business A cannot load B's AI draft by id", aSeesB == null);
  check("Business B cannot load A's AI draft by id", bSeesA == null);
  check("AI interactions stay on the requesting business", aInteractionOnB == null && bInteractionOnA == null);

  const aWebsite = await prisma.business.findFirst({
    where: { id: businessA.id },
    select: { publishedWebsiteId: true },
  });
  check("AI draft does not publish a website", aWebsite?.publishedWebsiteId == null);

  console.log(
    failures === 0 ? "\nAll marketing AI draft checks passed." : `\n${failures} marketing AI draft check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${testDbName}' AND pid <> pg_backend_pid()`,
    );
  } catch {
    /* ignore */
  }
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
