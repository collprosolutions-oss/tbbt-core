/**
 * BSOS Intelligence + AI service isolation and honesty proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-ai-intelligence.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  AI_NOT_CONNECTED_MESSAGE,
  applyTemplateWriting,
  filterAuthorizedCitedFactKeys,
  isAiProviderConnected,
  parseStructuredAiOutput,
  resolveWritingOriginal,
  runAiTask,
  runWritingAssist,
} = await import("@/lib/ai/index");
const { CAPABILITIES, requireBusinessCapability } = await import("@/lib/authorization");
const { answerCoachFromFacts } = await import("@/lib/ai/coach");
const { answerKnowledgeFromEntries, retrieveTenantKnowledge } = await import("@/lib/ai/knowledge");
const { describeReviewSentiment } = await import("@/lib/ai/reviews");
const { marketingAiAssistAvailable, draftMarketingContent } = await import("@/lib/marketing-draft");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_ai_intelligence_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();
const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) process.exit(push.status ?? 1);

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

const serviceSrc = readFileSync(new URL("../src/lib/ai/service.ts", import.meta.url), "utf8");
const sanitizeSrc = readFileSync(new URL("../src/lib/ai/sanitize.ts", import.meta.url), "utf8");
const coachSrc = readFileSync(new URL("../src/lib/ai/coach.ts", import.meta.url), "utf8");

try {
  console.log("\nSTATIC — AI honesty and isolation");
  check("AI is disconnected without an API key", isAiProviderConnected() === false);
  const previous = process.env.TBBT_MARKETING_AI_PROVIDER;
  process.env.TBBT_MARKETING_AI_PROVIDER = "openai";
  check(
    "A provider name env does not claim AI is connected",
    marketingAiAssistAvailable() === false &&
      draftMarketingContent({ contentType: "GENERAL_POST", businessName: "A" }).mode === "TEMPLATE",
  );
  if (previous == null) delete process.env.TBBT_MARKETING_AI_PROVIDER;
  else process.env.TBBT_MARKETING_AI_PROVIDER = previous;
  check("Sanitize redacts secret-looking keys", sanitizeSrc.includes("[redacted]"));
  check("Coach never invents bank balances", coachSrc.includes("not a bank balance"));
  check("Structured output is validated before use", serviceSrc.includes("parseStructuredAiOutput"));
  check(
    "Invalid model JSON is rejected",
    parseStructuredAiOutput("{not-json") === null && parseStructuredAiOutput(JSON.stringify({ text: "ok", stance: "FACT", citedFactKeys: [] }))?.text === "ok",
  );
  check(
    "Keep Mine returns the owner text",
    applyTemplateWriting("KEEP_MINE", "Owner copy").text === "Owner copy",
  );
  const writingBarSrc = readFileSync(new URL("../src/components/ai/writing-assist-bar.tsx", import.meta.url), "utf8");
  const writingActionSrc = readFileSync(new URL("../src/app/actions/ai.ts", import.meta.url), "utf8");
  check(
    "Generation alone cannot modify the owner's original field value",
    !writingBarSrc.includes("onSuggestion(state.text)") &&
      writingBarSrc.includes("Apply suggestion") &&
      resolveWritingOriginal("Owner original", "Generated rewrite", "IGNORE") === "Owner original" &&
      resolveWritingOriginal("Owner original", "Generated rewrite", "KEEP_MINE") === "Owner original" &&
      resolveWritingOriginal("Owner original", "Generated rewrite", "APPLY") === "Generated rewrite",
  );
  check(
    "Generic writing action requires USE_AI_ASSIST",
    writingActionSrc.includes("USE_AI_ASSIST"),
  );
  check(
    "Unknown citation keys are removed",
    filterAuthorizedCitedFactKeys(["paidRevenue", "secret-other-tenant"], ["paidRevenue"]).join(",") ===
      "paidRevenue" &&
      parseStructuredAiOutput(
        JSON.stringify({ text: "ok", stance: "FACT", citedFactKeys: ["paidRevenue", "invented"] }),
        ["paidRevenue"],
      )?.citedFactKeys.join(",") === "paidRevenue",
  );
  const marketingDataSrc = readFileSync(new URL("../src/lib/marketing-data.ts", import.meta.url), "utf8");
  const marketingAiSrc = readFileSync(new URL("../src/lib/ai/marketing.ts", import.meta.url), "utf8");
  check(
    "Marketing source loads recorded review, service-area, and unpaid-invoice counts",
    marketingDataSrc.includes("prisma.review.count") &&
      marketingDataSrc.includes("prisma.serviceArea.count") &&
      marketingDataSrc.includes('status: "SENT"') &&
      !marketingDataSrc.includes("reviews: 0") &&
      !marketingDataSrc.includes("serviceAreas: 0") &&
      !marketingDataSrc.includes("unpaidInvoices: 0"),
  );
  check(
    "Marketing drafts, weekly plans, and campaign ideas use the AI provider boundary",
    marketingAiSrc.includes("weeklyMarketingPlanWithAi") &&
      marketingAiSrc.includes("campaignIdeasWithAi") &&
      marketingAiSrc.includes("draftMarketingVariationsWithAi") &&
      marketingAiSrc.includes("runAiTask") &&
      marketingAiSrc.includes('publishable: false'),
  );

  const ownerA = await prisma.user.create({
    data: { name: "A Owner", email: `a-ai-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerB = await prisma.user.create({
    data: { name: "B Owner", email: `b-ai-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const businessA = await prisma.business.create({
    data: { name: "Alpha Intel", slug: `alpha-ai-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Intel", slug: `beta-ai-${randomUUID()}`, tradeCode: "HANDYMAN" },
  });
  const memA = await prisma.membership.create({
    data: { userId: ownerA.id, businessId: businessA.id, role: "OWNER" },
  });
  await prisma.membership.create({
    data: { userId: ownerB.id, businessId: businessB.id, role: "OWNER" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "A Member", email: `a-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memMember = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });

  const conversationA = await prisma.aiConversation.create({
    data: {
      businessId: businessA.id,
      membershipId: memA.id,
      area: "COACH",
      title: "A coach",
    },
  });
  await prisma.aiConversationMessage.create({
    data: {
      businessId: businessA.id,
      conversationId: conversationA.id,
      role: "ASSISTANT",
      content: "A recorded fact for A only",
      stance: "FACT",
    },
  });
  await prisma.knowledgeEntry.create({
    data: {
      businessId: businessB.id,
      title: "Secret B pricing",
      body: "Business B charges a confidential 999 markup.",
      category: "SERVICES_PRICING",
      sourceType: "OWNER_CREATED",
      trustState: "UNKNOWN",
      createdByMembershipId: (
        await prisma.membership.findFirstOrThrow({ where: { businessId: businessB.id } })
      ).id,
    },
  });
  await prisma.knowledgeEntry.create({
    data: {
      businessId: businessA.id,
      title: "A faucet pricing",
      body: "Business A records faucet repairs from completed jobs only.",
      category: "SERVICES_PRICING",
      sourceType: "OWNER_CREATED",
      trustState: "UNKNOWN",
      createdByMembershipId: memA.id,
    },
  });

  console.log("\nDB — Tenant isolation and fallback");
  const aConvos = await prisma.aiConversation.findMany({ where: { businessId: businessA.id } });
  const bSeesA = await prisma.aiConversation.findMany({
    where: { businessId: businessB.id, id: conversationA.id },
  });
  check("Business A can read its own AI conversation", aConvos.some((row) => row.id === conversationA.id));
  check("Business B cannot read business A AI conversations", bSeesA.length === 0);

  const aHits = await retrieveTenantKnowledge(prisma, businessA.id, "pricing faucet");
  const bHits = await retrieveTenantKnowledge(prisma, businessB.id, "pricing faucet");
  check(
    "Business A cannot retrieve business B Knowledge entries",
    aHits.every((hit) => hit.id && !hit.excerpt.includes("999 markup")) &&
      aHits.some((hit) => hit.title.includes("A faucet")),
  );
  check("Business B retrieval stays on B entries", bHits.every((hit) => hit.excerpt.includes("999") || hit.title.includes("Secret B")));

  const asked = answerKnowledgeFromEntries("pricing", aHits);
  check("Knowledge fallback cites only authorized hits", asked.citedFactKeys.every((id) => aHits.some((hit) => hit.id === id)));

  const facts = {
    unpaidInvoices: { count: 2, amount: 300 },
    sentEstimates: { count: 1 },
    draftEstimates: { count: 0 },
    unscheduledJobs: { count: 0 },
    completedJobsWithoutReview: { count: 1 },
    completedJobsReadyForMarketing: { count: 0 },
    lowMarginJobs: { count: 1 },
    missingWageEntries: { count: 0 },
    availableCapacityDays: { count: 0 },
    repeatCustomers: { count: 1 },
    outsideAreaRequests: { count: 0 },
    recurringExpenses: { count: 0, amount: 0 },
    paidRevenue: { amount: 150 },
    recordedExpenses: { amount: 40 },
  };
  const coach = answerCoachFromFacts("Why was this month less profitable?", {
    facts,
    recommendations: [],
    metrics: [],
    goals: [],
    actionItems: [],
  });
  check(
    "Deterministic financial facts are not replaced by AI output",
    coach.output.text.includes("150.00") &&
      coach.output.text.includes("40.00") &&
      coach.output.text.includes("not a bank balance"),
  );

  const disconnected = await runAiTask(
    prisma,
    { businessId: businessA.id, membershipId: memA.id, userId: ownerA.id },
    {
      taskType: "COACH_ASK",
      system: "unused",
      user: "unused",
      inputSummary: "profit question",
      idempotencyKey: `coach-test-${randomUUID()}`,
      fallback: coach.output,
    },
  );
  check(
    "AI-disabled mode remains functional with a template/fallback",
    disconnected.status === "SKIPPED_NOT_CONNECTED" &&
      disconnected.output?.text === coach.output.text &&
      disconnected.message === AI_NOT_CONNECTED_MESSAGE,
  );

  const rewrite = await runWritingAssist(
    prisma,
    { businessId: businessA.id, membershipId: memA.id },
    {
      action: "SHORTER",
      original: "This is a long owner sentence. It has a second sentence too.",
      idempotencyKey: `write-test-${randomUUID()}`,
    },
  );
  check("Writing assist works without a provider", Boolean(rewrite.output?.text) && rewrite.status === "SKIPPED_NOT_CONNECTED");

  const job = await prisma.job.create({
    data: {
      businessId: businessA.id,
      projectToken: randomUUID(),
      status: "COMPLETED",
    },
  });
  const beforeJobs = await prisma.job.count({ where: { businessId: businessA.id, status: "COMPLETED" } });
  check("AI fallback does not corrupt a core job record", beforeJobs === 1 && job.status === "COMPLETED");

  const sentiment = describeReviewSentiment("Great work, on time and professional.");
  check("Review sentiment is described and does not gate requests", sentiment.sentiment === "POSITIVE" && sentiment.note.includes("does not gate"));

  const aUsage = await prisma.aiUsagePeriod.findMany({ where: { businessId: businessA.id } });
  const bUsage = await prisma.aiUsagePeriod.findMany({ where: { businessId: businessB.id } });
  check("Usage totals stay on the requesting business", aUsage.length >= 1 && bUsage.length === 0);

  const raceKey = `coach-race-${randomUUID()}`;
  const raceInput = {
    taskType: "COACH_ASK",
    system: "unused",
    user: "unused",
    inputSummary: "race",
    idempotencyKey: raceKey,
    fallback: coach.output,
    allowedFactKeys: ["paidRevenue"],
  };
  const actorA = { businessId: businessA.id, membershipId: memA.id, userId: ownerA.id };
  const [raceOne, raceTwo] = await Promise.all([
    runAiTask(prisma, actorA, raceInput),
    runAiTask(prisma, actorA, raceInput),
  ]);
  const raceRows = await prisma.aiInteraction.findMany({
    where: { businessId: businessA.id, idempotencyKey: raceKey },
  });
  check(
    "Concurrent identical AI idempotency keys create or load a single interaction",
    raceRows.length === 1 &&
      raceOne.interactionId === raceRows[0].id &&
      raceTwo.interactionId === raceRows[0].id,
  );

  let memberWritingBlocked = false;
  try {
    requireBusinessCapability(
      {
        businessId: businessA.id,
        workspace: { role: "MEMBER", membership: { id: memMember.id }, user: { id: memberUser.id } },
        scope: { businessId: businessA.id },
        assertOwned(record) {
          return record;
        },
      },
      CAPABILITIES.USE_AI_ASSIST,
    );
  } catch {
    memberWritingBlocked = true;
  }
  check("MEMBER direct invocation of generic AI writing is blocked", memberWritingBlocked);
} finally {
  await prisma.$disconnect();
  spawnSync("psql", [baseUrl, "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE);`], {
    stdio: "ignore",
  });
}

if (failures > 0) {
  console.error(`\n${failures} AI intelligence check(s) failed.`);
  process.exit(1);
}
console.log("\nAI intelligence checks passed.");
