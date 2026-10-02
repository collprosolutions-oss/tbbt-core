/**
 * OWNER-requested Marketing Studio content draft.
 *
 * Uses the canonical runAiTask / resolveAiProvider path. Proves OWNER
 * authorization, tenant isolation, Unavailable when the provider is not
 * configured, and fake-provider failure handling. Generated items stay
 * reviewable DRAFT records. No live AI call, website publish, social
 * post, or customer message.
 *
 * Run with:
 *   npm run test:marketing-owner-content-draft
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for owner content draft checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const {
  MARKETING_OWNER_DRAFT_BURST_BOUNDED_MESSAGE,
  MARKETING_OWNER_DRAFT_BURST_LIMIT,
  MARKETING_OWNER_DRAFT_COST_BOUNDED_MESSAGE,
  MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS,
  MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS,
  MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT,
  MARKETING_OWNER_DRAFT_MONTHLY_TOKEN_BUDGET,
  MARKETING_OWNER_DRAFT_REVIEW_MESSAGE,
  MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE,
  OWNER_CONTENT_DRAFT_MESSAGE,
  canRequestOwnerMarketingContentDraft,
} = await import("@/lib/marketing");
const { MarketingError } = await import("@/lib/marketing-ops");
const { requestOwnerMarketingContentDraft } = await import("@/lib/ai/marketing");
const { AI_FAILURE_MESSAGE, shouldRotateAiAttemptId } = await import("@/lib/ai/types");
const { sanitizeAiText } = await import("@/lib/ai/sanitize");
const { loadMarketingSource } = await import("@/lib/marketing-data");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function readSrc(relative) {
  return readFileSync(join(root, relative), "utf8");
}

const previousAiKey = process.env.TBBT_AI_API_KEY;
const previousOpenAiKey = process.env.OPENAI_API_KEY;
delete process.env.TBBT_AI_API_KEY;
delete process.env.OPENAI_API_KEY;

const marketingAiSrc = readSrc("src/lib/ai/marketing.ts");
const providerSrc = readSrc("src/lib/ai/provider.ts");
const serviceSrc = readSrc("src/lib/ai/service.ts");
const sanitizeSrc = readSrc("src/lib/ai/sanitize.ts");
const typesSrc = readSrc("src/lib/ai/types.ts");
const actionSrc = readSrc("src/app/actions/marketing.ts");
const formSrc = readSrc("src/components/marketing/request-owner-content-draft.tsx");
const workspaceSrc = readSrc("src/components/marketing/marketing-workspace.tsx");
const createFormSrc = readSrc("src/components/marketing/create-content-form.tsx");
const generatePanelSrc = readSrc("src/components/marketing/generate-ai-panel.tsx");
const ownerFnSrc = marketingAiSrc.slice(
  marketingAiSrc.indexOf("export async function requestOwnerMarketingContentDraft"),
);
const reserveFnSrc = marketingAiSrc.slice(
  marketingAiSrc.indexOf("async function reserveOwnerMarketingDraftSlot"),
  marketingAiSrc.indexOf("export type OwnerMarketingContentDraftResult"),
);
const budgetFnSrc = marketingAiSrc.slice(
  marketingAiSrc.indexOf("export async function marketingOwnerDraftBudgetUsed"),
  marketingAiSrc.indexOf("async function reserveOwnerMarketingDraftSlot"),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_marketing_owner_draft_test";
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
  console.error("Failed to push schema for owner content draft test database.");
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

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, user: { id: userId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function fakeFailingProvider(calls) {
  return {
    id: "fake",
    connected: true,
    async complete() {
      calls.push("fail");
      return {
        ok: false,
        provider: "fake",
        error: "fake provider failed",
        retryable: false,
        latencyMs: 1,
      };
    },
  };
}

function fakeSucceedingProvider(calls, text = "Local faucet repair update. Review this draft before any post.", delayMs = 0) {
  return {
    id: "fake",
    connected: true,
    async complete(request) {
      calls.push(request);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        ok: true,
        provider: "fake",
        model: "fake-test",
        text: JSON.stringify({
          text,
          stance: "RECOMMENDATION",
          citedFactKeys: ["workPerformed"],
          notes: "Draft only.",
        }),
        usage: { promptTokens: 20, completionTokens: 30 },
        latencyMs: delayMs || 1,
      };
    },
  };
}

function fakeSecretFailureProvider(calls) {
  return {
    id: "fake",
    connected: true,
    async complete(request) {
      calls.push(request);
      return {
        ok: false,
        provider: "fake",
        error: "upstream rejected key sk-proj-secretvalue123",
        retryable: false,
        latencyMs: 1,
      };
    },
  };
}

try {
  console.log("\nSTATIC — OWNER draft uses the canonical provider path");
  check("OWNER may request a content draft", canRequestOwnerMarketingContentDraft("OWNER") === true);
  check("ADMIN cannot request a content draft", canRequestOwnerMarketingContentDraft("ADMIN") === false);
  check("MEMBER cannot request a content draft", canRequestOwnerMarketingContentDraft("MEMBER") === false);
  check("Unavailable label is exact", MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE === "Unavailable");
  check("Input is bounded", MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS === 2_000);
  check("Output tokens are bounded", MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS === 400);
  check("Monthly request count is bounded", MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT === 25);
  check("Monthly token budget is bounded", MARKETING_OWNER_DRAFT_MONTHLY_TOKEN_BUDGET === 8_000);
  check("Burst limit is short", MARKETING_OWNER_DRAFT_BURST_LIMIT === 5);
  check(
    "Owner draft uses runAiTask and MARKETING_DRAFT",
    ownerFnSrc.includes("runAiTask") &&
      ownerFnSrc.includes('taskType: "MARKETING_DRAFT"') &&
      ownerFnSrc.includes("maxOutputTokens: MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS") &&
      ownerFnSrc.includes("MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS"),
  );
  check(
    "Budget check counts PENDING and reserves under an advisory lock",
    marketingAiSrc.includes('OWNER_DRAFT_COUNTED_STATUSES') &&
      marketingAiSrc.includes('"PENDING"') &&
      budgetFnSrc.includes("OWNER_DRAFT_COUNTED_STATUSES") &&
      reserveFnSrc.includes("pg_advisory_xact_lock") &&
      reserveFnSrc.includes('status: "PENDING"') &&
      ownerFnSrc.includes("reserveOwnerMarketingDraftSlot"),
  );
  check(
    "Disconnected provider is checked before an interaction row",
    ownerFnSrc.includes("resolveAiProvider") &&
      ownerFnSrc.indexOf("!provider.connected") < ownerFnSrc.indexOf("reserveOwnerMarketingDraftSlot"),
  );
  check(
    "Fact fields are marked untrusted for the model",
    ownerFnSrc.includes("untrusted data") && ownerFnSrc.includes("owner note"),
  );
  check(
    "sk-proj- keys are redacted from stored failure reasons",
    sanitizeSrc.includes("sk-proj-") &&
      serviceSrc.includes("failureReason: sanitizeAiText(completed.error, 400)"),
  );
  check(
    "FAILED, VALIDATION_FAILED, and budget Unavailable rotate the attempt id",
    typesSrc.includes('state.status === "FAILED"') &&
      typesSrc.includes('state.status === "VALIDATION_FAILED"') &&
      typesSrc.includes('state.status === "UNAVAILABLE"') &&
      formSrc.includes("shouldRotateAiAttemptId(state)") &&
      shouldRotateAiAttemptId({ status: "FAILED" }) === true &&
      shouldRotateAiAttemptId({ status: "VALIDATION_FAILED" }) === true &&
      shouldRotateAiAttemptId({ status: "UNAVAILABLE" }) === true &&
      shouldRotateAiAttemptId({ status: "FAILED", inProgress: true }) === false,
  );
  check(
    "Owner draft does not add a second production provider",
    providerSrc.includes("DisconnectedAiProvider") &&
      providerSrc.includes("OpenAiCompatibleProvider") &&
      !providerSrc.includes("class ") &&
      !marketingAiSrc.includes("new OpenAiCompatibleProvider") &&
      !ownerFnSrc.includes("fetch("),
  );
  check(
    "Canonical service still resolves one provider",
    serviceSrc.includes("input.provider ?? resolveAiProvider()"),
  );
  check(
    "Owner draft does not persist a template or creator package",
    !ownerFnSrc.includes("draftMarketingContent") &&
      !ownerFnSrc.includes("createMarketingStudioPackage") &&
      !ownerFnSrc.includes("draftMarketingVariations"),
  );
  check(
    "Owner draft never publishes, posts, or messages customers",
    ownerFnSrc.includes("published: false") &&
      ownerFnSrc.includes("posted: false") &&
      ownerFnSrc.includes("customerMessageSent: false") &&
      !ownerFnSrc.includes("PUBLISHED") &&
      !ownerFnSrc.includes("sendCustomer") &&
      !ownerFnSrc.includes("publishWebsite"),
  );
  check(
    "Server action exposes the OWNER request",
    actionSrc.includes("requestOwnerMarketingContentDraftAction") &&
      actionSrc.includes("requestOwnerMarketingContentDraft"),
  );
  check(
    "UI shows Unavailable when the provider is not configured",
    formSrc.includes("MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE") &&
      formSrc.includes("providerConfigured") &&
      workspaceSrc.includes("RequestOwnerContentDraftForm") &&
      workspaceSrc.includes("isAiProviderConnected()"),
  );
  check(
    "Template creator-package form stays a separate path",
    createFormSrc.includes("Save creator package draft") &&
      generatePanelSrc.includes("Generate AI variations"),
  );
  check("OWNER-only message is exact", OWNER_CONTENT_DRAFT_MESSAGE.includes("OWNER role"));

  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-draft-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-draft-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-draft-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaOwner = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-draft-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Drafts",
      slug: `alpha-draft-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      publicServiceAreaLabel: "Reno",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Drafts",
      slug: `beta-draft-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      publicServiceAreaLabel: "Sparks",
    },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaOwner.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id, betaOwner.id);

  const catalog = await prisma.serviceCatalogItem.create({
    data: { businessId: businessA.id, name: "Faucet repair", active: true },
  });
  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const estimate = await prisma.estimate.create({
    data: { businessId: businessA.id, customerId: customer.id, publicToken: randomUUID() },
  });
  await prisma.lineItem.create({
    data: {
      businessId: businessA.id,
      estimateId: estimate.id,
      description: "GATE-CODE-9981 hide-a-key",
      quantity: 1,
      unitPrice: 80,
      total: 80,
      type: "LABOR",
      serviceCatalogItemId: catalog.id,
    },
  });
  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customer.id,
      estimateId: estimate.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });
  const betaCustomer = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Secret" },
  });
  const betaJob = await prisma.job.create({
    data: {
      businessId: businessB.id,
      customerId: betaCustomer.id,
      status: "COMPLETED",
      projectToken: randomUUID(),
    },
  });

  console.log("\nTEST — Unavailable when the provider is not configured");
  const disconnected = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: randomUUID(),
    jobId: job.id,
  });
  const disconnectedContents = await prisma.marketingContent.count({ where: { businessId: businessA.id } });
  const disconnectedInteractions = await prisma.aiInteraction.count({
    where: { businessId: businessA.id, taskType: "MARKETING_DRAFT" },
  });
  check(
    "Disconnected OWNER request is Unavailable",
    disconnected.status === "UNAVAILABLE" &&
      disconnected.message === MARKETING_OWNER_DRAFT_UNAVAILABLE_MESSAGE &&
      disconnected.contentId == null &&
      disconnected.publishable === false &&
      disconnected.published === false &&
      disconnected.posted === false &&
      disconnected.customerMessageSent === false,
  );
  check("Disconnected request does not create a content draft", disconnectedContents === 0);
  check("Disconnected request does not write an interaction row", disconnectedInteractions === 0);

  await expectError(
    "ADMIN cannot request an owner content draft",
    () => requestOwnerMarketingContentDraft(prisma, adminA, { attemptId: randomUUID() }),
    (error) => error instanceof MarketingError && error.message === OWNER_CONTENT_DRAFT_MESSAGE,
  );
  await expectError(
    "MEMBER cannot request an owner content draft",
    () => requestOwnerMarketingContentDraft(prisma, memberA, { attemptId: randomUUID() }),
    (error) =>
      error instanceof ForbiddenError ||
      (error instanceof MarketingError && error.message === OWNER_CONTENT_DRAFT_MESSAGE),
  );

  console.log("\nTEST — Fake-provider failure does not invent a draft");
  const failCalls = [];
  const failed = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: randomUUID(),
    jobId: job.id,
    provider: fakeFailingProvider(failCalls),
  });
  const afterFailContents = await prisma.marketingContent.count({ where: { businessId: businessA.id } });
  const afterFailJobs = await prisma.job.findMany({
    where: { businessId: { in: [businessA.id, businessB.id] } },
    select: { id: true, status: true, businessId: true },
  });
  const failInteraction = await prisma.aiInteraction.findFirst({
    where: { id: failed.interactionId },
  });
  const betaFailInteractions = await prisma.aiInteraction.count({
    where: { businessId: businessB.id },
  });
  check("Fake provider was invoked once", failCalls.length === 1);
  check(
    "Fake-provider failure stays FAILED and unpublished",
    failed.status === "FAILED" &&
      failed.message === AI_FAILURE_MESSAGE &&
      failed.contentId == null &&
      failed.published === false &&
      failed.posted === false &&
      failed.customerMessageSent === false,
  );
  check("Fake-provider failure does not create a MarketingContent row", afterFailContents === 0);
  check(
    "Core job records stay COMPLETED after provider failure",
    afterFailJobs.every((row) => row.status === "COMPLETED") &&
      afterFailJobs.some((row) => row.id === job.id && row.businessId === businessA.id) &&
      afterFailJobs.some((row) => row.id === betaJob.id && row.businessId === businessB.id),
  );
  check(
    "Failed interaction stays on tenant A",
    failInteraction?.businessId === businessA.id &&
      failInteraction.status === "FAILED" &&
      betaFailInteractions === 0,
  );

  console.log("\nTEST — Tenant isolation and successful fake provider");
  await expectError(
    "OWNER B cannot draft from tenant A's job",
    () =>
      requestOwnerMarketingContentDraft(prisma, ownerB, {
        attemptId: randomUUID(),
        jobId: job.id,
        provider: fakeSucceedingProvider([]),
      }),
    (error) => error instanceof Error,
  );
  const betaAfterIsolation = await prisma.marketingContent.count({ where: { businessId: businessB.id } });
  check("Tenant B has no content after using A's job id", betaAfterIsolation === 0);

  const successCalls = [];
  const draftText = "Reno faucet repair update from recorded work. Review this draft.";
  const created = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: randomUUID(),
    jobId: job.id,
    ownerNote: "Keep it local.",
    provider: fakeSucceedingProvider(successCalls, draftText),
  });
  const stored = await prisma.marketingContent.findFirst({
    where: { id: created.contentId, businessId: businessA.id },
  });
  const sourceA = await loadMarketingSource(prisma, businessA.id);
  const sourceB = await loadMarketingSource(prisma, businessB.id);
  const usageA = await prisma.aiUsagePeriod.findMany({ where: { businessId: businessA.id } });
  const usageB = await prisma.aiUsagePeriod.findMany({ where: { businessId: businessB.id } });
  check("Successful fake provider creates one DRAFT", created.status === "COMPLETED" && stored?.status === "DRAFT");
  check("Saved draft uses the provider text", stored?.body === draftText && created.text === draftText);
  check("Saved draft message requires review", created.message === MARKETING_OWNER_DRAFT_REVIEW_MESSAGE);
  check(
    "Saved draft is not published, posted, or sent",
    created.publishable === false &&
      created.published === false &&
      created.posted === false &&
      created.customerMessageSent === false &&
      stored?.channelIntent === "UNASSIGNED" &&
      stored?.plannedFor == null,
  );
  check("Saved draft links the same-tenant completed job", stored?.jobId === job.id);
  check(
    "Provider input stays bounded and omits customer secrets",
    successCalls.length === 1 &&
      successCalls[0].user.length <= MARKETING_OWNER_DRAFT_MAX_INPUT_CHARS &&
      successCalls[0].maxOutputTokens === MARKETING_OWNER_DRAFT_MAX_OUTPUT_TOKENS &&
      !successCalls[0].user.includes("Ada Homeowner") &&
      !successCalls[0].user.includes("GATE-CODE-9981") &&
      successCalls[0].user.includes("Faucet repair"),
  );
  check("Tenant A source lists the new draft", sourceA.contents.some((row) => row.id === stored.id && row.status === "DRAFT"));
  check("Tenant B cannot see tenant A's draft", sourceB.contents.every((row) => row.id !== stored.id) && sourceB.contents.length === 0);
  check("Usage totals stay on the requesting business", usageA.length >= 1 && usageB.length === 0);

  const replayId = randomUUID();
  const replayCalls = [];
  const first = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: replayId,
    provider: fakeSucceedingProvider(replayCalls, "Replayable owner draft."),
  });
  const second = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: replayId,
    provider: fakeSucceedingProvider(replayCalls, "Replayable owner draft."),
  });
  const replayRows = await prisma.marketingContent.findMany({
    where: { businessId: businessA.id, body: "Replayable owner draft." },
  });
  check(
    "Same attempt id creates one reviewable draft and calls the provider once",
    first.contentId === second.contentId &&
      replayRows.length === 1 &&
      replayRows[0].status === "DRAFT" &&
      replayCalls.length === 1,
  );

  const secretCalls = [];
  const secretFailed = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: randomUUID(),
    provider: fakeSecretFailureProvider(secretCalls),
    budget: { burstLimit: 1000 },
  });
  const secretRow = await prisma.aiInteraction.findFirst({
    where: { id: secretFailed.interactionId },
  });
  check(
    "Provider secrets are redacted on stored failureReason",
    secretFailed.status === "FAILED" &&
      secretCalls.length === 1 &&
      typeof secretRow?.failureReason === "string" &&
      !secretRow.failureReason.includes("sk-proj-secretvalue123") &&
      secretRow.failureReason.includes("[redacted]") &&
      sanitizeAiText("sk-proj-secretvalue123").includes("[redacted]"),
  );

  console.log("\nTEST — Cost bound refuses another provider call");
  const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  await prisma.aiInteraction.createMany({
    data: Array.from({ length: MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT }, () => ({
      businessId: businessA.id,
      membershipId: ownerMem.id,
      userId: ownerUser.id,
      taskType: "MARKETING_DRAFT",
      status: "COMPLETED",
      inputSummary: "seed",
      idempotencyKey: `seed-${randomUUID()}`,
      promptTokens: 10,
      completionTokens: 10,
      createdAt: periodStart,
    })),
  });
  const costCalls = [];
  const bounded = await requestOwnerMarketingContentDraft(prisma, ownerA, {
    attemptId: randomUUID(),
    provider: fakeSucceedingProvider(costCalls, "Should not be stored."),
    budget: { burstLimit: 1000 },
  });
  const leaked = await prisma.marketingContent.count({
    where: { businessId: businessA.id, body: "Should not be stored." },
  });
  check(
    "Exhausted monthly budget is Unavailable and creates no draft",
    bounded.status === "UNAVAILABLE" &&
      bounded.message === MARKETING_OWNER_DRAFT_COST_BOUNDED_MESSAGE &&
      bounded.contentId == null &&
      costCalls.length === 0 &&
      leaked === 0,
  );

  console.log("\nTEST — Concurrent stampede cannot exceed the monthly cap");
  const raceOwner = await prisma.user.create({
    data: { name: "Race Owner", email: `race-draft-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const raceBusiness = await prisma.business.create({
    data: {
      name: "Race Drafts",
      slug: `race-draft-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const raceMem = await prisma.membership.create({
    data: { userId: raceOwner.id, businessId: raceBusiness.id, role: "OWNER" },
  });
  const raceAccess = makeAccess(raceBusiness.id, "OWNER", raceMem.id, raceOwner.id);
  const raceCalls = [];
  const raceResults = await Promise.all(
    Array.from({ length: 40 }, () =>
      requestOwnerMarketingContentDraft(prisma, raceAccess, {
        attemptId: randomUUID(),
        provider: fakeSucceedingProvider(raceCalls, "Concurrent owner draft.", 400),
        budget: { burstLimit: 1000 },
      }),
    ),
  );
  const raceCompleted = raceResults.filter((row) => row.status === "COMPLETED");
  const raceUnavailable = raceResults.filter((row) => row.status === "UNAVAILABLE");
  const raceContents = await prisma.marketingContent.count({ where: { businessId: raceBusiness.id } });
  const raceInteractions = await prisma.aiInteraction.count({
    where: {
      businessId: raceBusiness.id,
      taskType: "MARKETING_DRAFT",
      status: { in: ["PENDING", "COMPLETED", "FAILED", "VALIDATION_FAILED"] },
    },
  });
  check(
    "40 concurrent requests make at most 25 provider calls",
    raceCalls.length <= MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT &&
      raceCompleted.length <= MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT &&
      raceContents <= MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT &&
      raceInteractions <= MARKETING_OWNER_DRAFT_MONTHLY_REQUEST_LIMIT &&
      raceUnavailable.length === 40 - raceCompleted.length &&
      raceCalls.length === raceCompleted.length,
  );
  const afterRace = await requestOwnerMarketingContentDraft(prisma, raceAccess, {
    attemptId: randomUUID(),
    provider: fakeSucceedingProvider([], "After race should refuse."),
    budget: { burstLimit: 1000 },
  });
  check(
    "A sequential request after the stampede is refused",
    afterRace.status === "UNAVAILABLE" &&
      afterRace.message === MARKETING_OWNER_DRAFT_COST_BOUNDED_MESSAGE &&
      afterRace.contentId == null,
  );

  console.log("\nTEST — Short burst limit serializes a smaller stampede");
  const burstOwner = await prisma.user.create({
    data: { name: "Burst Owner", email: `burst-draft-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const burstBusiness = await prisma.business.create({
    data: {
      name: "Burst Drafts",
      slug: `burst-draft-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
    },
  });
  const burstMem = await prisma.membership.create({
    data: { userId: burstOwner.id, businessId: burstBusiness.id, role: "OWNER" },
  });
  const burstAccess = makeAccess(burstBusiness.id, "OWNER", burstMem.id, burstOwner.id);
  const burstCalls = [];
  const burstResults = await Promise.all(
    Array.from({ length: 12 }, () =>
      requestOwnerMarketingContentDraft(prisma, burstAccess, {
        attemptId: randomUUID(),
        provider: fakeSucceedingProvider(burstCalls, "Burst owner draft.", 200),
        budget: { monthlyRequestLimit: 100, burstLimit: MARKETING_OWNER_DRAFT_BURST_LIMIT },
      }),
    ),
  );
  check(
    "Burst stampede cannot exceed the short per-business burst limit",
    burstCalls.length <= MARKETING_OWNER_DRAFT_BURST_LIMIT &&
      burstResults.filter((row) => row.status === "COMPLETED").length <= MARKETING_OWNER_DRAFT_BURST_LIMIT &&
      burstResults.some((row) => row.status === "UNAVAILABLE" && row.message === MARKETING_OWNER_DRAFT_BURST_BOUNDED_MESSAGE),
  );
} finally {
  if (previousAiKey == null) delete process.env.TBBT_AI_API_KEY;
  else process.env.TBBT_AI_API_KEY = previousAiKey;
  if (previousOpenAiKey == null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  await prisma.$disconnect();
  spawnSync("psql", [baseUrl, "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`], {
    stdio: "ignore",
  });
}

if (failures > 0) {
  console.error(`\n${failures} owner content draft check(s) failed.`);
  process.exit(1);
}
console.log("\nOwner content draft checks passed.");
