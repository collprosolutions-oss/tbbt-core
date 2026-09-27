/**
 * Controlled AI durable action ledger & provenance proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-controlled-ai-provenance.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES } = await import("@/lib/authorization");
const { formatDateTime } = await import("@/lib/format");
const { APP_NAV } = await import("@/lib/nav");
const {
  ACTION_CENTER_HISTORY_PATH,
  ACTION_CENTER_ORIGIN_NOT_RECORDED,
  CONTROLLED_ACTION_KEYS,
  CONTROLLED_AI_ATTEMPT_RESULTS,
  canConfirmControlledActions,
  confirmControlledAction,
  executableControlledActionKeys,
  findCatalogRecommendation,
  isExcludedActionKey,
  loadControlledActionCenter,
  loadControlledAiActionAttempt,
  loadControlledAiActionHistory,
  proposeControlledAction,
  recordedOwnerPlanStateClaimsControlledAction,
  resetControlledActionAttempts,
} = await import("@/lib/chief-of-staff");
const {
  recommendationEvidenceKey,
  upsertRecommendationState,
} = await import("@/lib/bsos-actions");
const {
  existingAttemptMatchesWrite,
  recordControlledAiAttempt,
} = await import("@/lib/chief-of-staff/controlled-actions");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_controlled_ai_provenance_test";
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
const { Prisma, PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      user: { id: userId, email: `${role.toLowerCase()}@example.com`, name: role },
    },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
    assertAttachable(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

async function ledgerCount(businessId) {
  return prisma.controlledAiActionAttempt.count({ where: { businessId } });
}

async function executedCount(businessId, actionKey) {
  return prisma.controlledAiActionAttempt.count({
    where: { businessId, actionKey, result: "EXECUTED" },
  });
}

async function seedAttempt(input) {
  return prisma.controlledAiActionAttempt.create({
    data: {
      businessId: input.businessId,
      actionKey: input.actionKey,
      result: input.result,
      recommendationKey: input.recommendationKey,
      targetEntityType: "RECOMMENDATION",
      targetRecordType: input.targetRecordType ?? null,
      targetRecordId: input.targetRecordId ?? null,
      confirmedByMembershipId: input.membershipId,
      confirmedByUserId: input.userId,
      resultCode: input.resultCode,
      resultMessage: input.resultMessage,
      executionAttemptId: input.executionAttemptId,
      executedAt: input.result === "EXECUTED" || input.result === "REPLAYED" ? new Date() : null,
    },
  });
}

const controlledSrc = readRepo("src/lib/chief-of-staff/controlled-actions.ts");
const provenanceSrc = readRepo("src/lib/chief-of-staff/controlled-ai-provenance.ts");
const actionCenterSrc = readRepo("src/lib/chief-of-staff/action-center.ts");
const actionSrc = readRepo("src/app/actions/ai.ts");
const pageSrc = readRepo("src/app/(app)/actions/page.tsx");
const historyPageSrc = readRepo("src/app/(app)/actions/history/page.tsx");
const historyUiSrc = readRepo("src/components/actions/action-center-history.tsx");
const boardSrc = readRepo("src/components/actions/action-center-board.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const packageSrc = readRepo("package.json");
const migrationSrc = readRepo("prisma/migrations/20260927120000_controlled_ai_action_attempt/migration.sql");

try {
  console.log("\nSTATIC — durable ledger stays additive, confirmation-only, and allowlist-stable");
  check(
    "Existing allowlist remains unchanged",
    CONTROLLED_ACTION_KEYS.join(",") ===
      "CREATE_RECOMMENDATION_ACTION_ITEM,DISMISS_RECOMMENDATION,COMPLETE_RECOMMENDATION" &&
      CONTROLLED_ACTION_KEYS.length === 3,
  );
  check(
    "High-risk keys stay excluded",
    ["SEND_CUSTOMER_EMAIL", "CHARGE_CARD", "MARK_PAID", "TRANSFER_OWNERSHIP"].every(
      (key) => isExcludedActionKey(key) && !executableControlledActionKeys().includes(key),
    ),
  );
  check(
    "One canonical provenance model was added",
    schemaSrc.includes("model ControlledAiActionAttempt") &&
      !schemaSrc.includes("model AiActionProposal") &&
      !schemaSrc.includes("model ControlledActionProposal"),
  );
  const ledgerModel = schemaSrc.slice(
    schemaSrc.indexOf("model ControlledAiActionAttempt"),
    schemaSrc.indexOf("model ", schemaSrc.indexOf("model ControlledAiActionAttempt") + 1),
  );
  const ledgerFields = [...ledgerModel.matchAll(/^\s{2}(\w+)\s+/gm)].map((match) => match[1]);
  check(
    "Ledger fields stay bounded and omit prompts/secrets/PII bodies",
    [
      "actionKey",
      "result",
      "recommendationKey",
      "confirmedByMembershipId",
      "resultCode",
      "resultMessage",
      "executionAttemptId",
    ].every((field) => ledgerFields.includes(field)) &&
      !ledgerFields.some((field) => /prompt|secret|apiKey|payload|messageBody|chainOfThought/i.test(field)) &&
      !/DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i.test(migrationSrc) &&
      migrationSrc.includes("CREATE TABLE IF NOT EXISTS") &&
      !controlledSrc.includes("$executeRawUnsafe") &&
      !provenanceSrc.includes("CREATE TABLE"),
  );
  check(
    "Preview/propose and Action Center reads do not write the ledger",
    !controlledSrc.includes("recordControlledAiAttempt(db, access") ||
      controlledSrc.indexOf("export async function proposeControlledAction") <
        controlledSrc.indexOf("export async function confirmControlledAction"),
  );
  check(
    "proposeControlledAction never calls the ledger writer",
    !controlledSrc
      .slice(
        controlledSrc.indexOf("export async function proposeControlledAction"),
        controlledSrc.indexOf("export type ConfirmControlledActionInput"),
      )
      .includes("recordControlledAiAttempt") &&
      !actionCenterSrc.includes("controlledAiActionAttempt.create") &&
      !actionCenterSrc.includes("recordControlledAiAttempt") &&
      !provenanceSrc.includes(".create("),
  );
  const confirmSrc = controlledSrc.slice(controlledSrc.indexOf("export async function confirmControlledAction"));
  check(
    "Success domain write and provenance share one Prisma transaction",
    confirmSrc.includes("withOwnedTransaction") &&
      confirmSrc.includes("await invokeCanonicalOperation(tx, access, entry, live)") &&
      confirmSrc.includes("await createControlledAiAttemptStrict(tx, access, {") &&
      confirmSrc.indexOf("await invokeCanonicalOperation(tx, access, entry, live)") <
        confirmSrc.indexOf("await createControlledAiAttemptStrict(tx, access, {"),
  );
  check(
    "Existing attempt is consulted after fingerprint and before domain mutation",
    confirmSrc.indexOf("if (serverProposal.fingerprint !== input.proposal.fingerprint)") <
      confirmSrc.indexOf("const existingAttempt = await findControlledAiAttempt") &&
      confirmSrc.indexOf("const existingAttempt = await findControlledAiAttempt") <
        confirmSrc.indexOf("const already = await alreadyAppliedResult") &&
      confirmSrc.indexOf("const already = await alreadyAppliedResult") <
        confirmSrc.indexOf("await invokeCanonicalOperation(tx, access, entry, live)"),
  );
  const recordAttemptSrc = controlledSrc.slice(
    controlledSrc.indexOf("export async function recordControlledAiAttempt"),
    controlledSrc.indexOf("async function recoverExistingAttemptAfterTransaction"),
  );
  check(
    "Unique-conflict recovery does not treat any existing row as a match",
    existingAttemptMatchesWrite({ result: "EXECUTED" }, { result: "REPLAYED" }) &&
      existingAttemptMatchesWrite({ result: "FAILED" }, { result: "FAILED" }) &&
      !existingAttemptMatchesWrite({ result: "FAILED" }, { result: "EXECUTED" }) &&
      !existingAttemptMatchesWrite({ result: "DENIED" }, { result: "EXECUTED" }) &&
      !existingAttemptMatchesWrite({ result: "FAILED" }, { result: "DENIED" }) &&
      recordAttemptSrc.includes("existingAttemptMatchesWrite(existing, input)") &&
      recordAttemptSrc.includes("already finished with a different result") &&
      !recordAttemptSrc.includes("if (existing) return existing"),
  );
  check(
    "Ledger unique race is recovered outside the failed transaction",
    confirmSrc.includes("recoverExistingAttemptAfterTransaction(db, access") &&
      confirmSrc.includes("createControlledAiAttemptStrict(tx") &&
      !confirmSrc.includes("await recordControlledAiAttempt(tx"),
  );
  check(
    "Actor name requires same-tenant Membership ownership",
    provenanceSrc.includes("confirmedBy.businessId !== access.businessId") &&
      provenanceSrc.includes("confirmedByName: sameTenantActorName") &&
      !provenanceSrc.includes("confirmedByUserId"),
  );
  check(
    "Action Center copy no longer says failures are unpersisted",
    boardSrc.includes("kept separately in Controlled AI history") &&
      !boardSrc.includes("Failed confirmations are not persisted as attempts."),
  );
  check(
    "No backfill inference from generic owner-plan rows",
    !controlledSrc.includes("function infer") &&
      !provenanceSrc.includes("function infer") &&
      !actionCenterSrc.includes("function inferActionKey") &&
      !provenanceSrc.includes("businessActionItem.findMany") &&
      provenanceSrc.includes("Never infers origin") &&
      actionCenterSrc.includes('origin: ACTION_CENTER_ORIGIN_NOT_RECORDED') &&
      CONTROLLED_AI_ATTEMPT_RESULTS.join(",") === "EXECUTED,REPLAYED,FAILED,DENIED",
  );
  check(
    "History uses Business.timezone for display only",
    provenanceSrc.includes("resolveBusinessTimeZone") &&
      provenanceSrc.includes("formatDateTime(row.confirmedAt, timeZone)") &&
      !provenanceSrc.includes("ensureBusinessTimezoneSchema"),
  );
  check(
    "History route is an Action Center child and nav is unchanged",
    ACTION_CENTER_HISTORY_PATH === "/actions/history" &&
      historyPageSrc.includes("loadControlledAiActionHistory") &&
      pageSrc.includes("ACTION_CENTER_HISTORY_PATH") &&
      !APP_NAV.some((item) => item.href === "/actions" || item.href === "/actions/history") &&
      !navSrc.includes('href: "/actions"') &&
      !packageSrc.includes("check-controlled-ai-provenance"),
  );
  check(
    "History UI does not mix generic rows into Controlled AI provenance",
    historyUiSrc.includes("Generic owner-plan rows are not shown") &&
      !historyUiSrc.includes("recordedOwnerPlanState") &&
      !boardSrc.includes("Confirmed Controlled AI actions") &&
      pageSrc.includes("origin is not recorded in Controlled Actions V1"),
  );
  check(
    "Confirm server action still requires explicit confirm and revalidates history",
    actionSrc.includes("confirmControlledAction(prisma, access") &&
      actionSrc.includes('revalidatePath("/actions/history")') &&
      actionSrc.includes('readString(formData, "confirm")'),
  );

  console.log("\nRUNTIME — confirmation-only ledger, atomicity, isolation, no inference");
  resetControlledActionAttempts();

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Provenance",
      slug: `alpha-provenance-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Chicago",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Provenance",
      slug: `beta-provenance-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-prov-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery", email: `admin-prov-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-prov-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-prov-${randomUUID()}@example.com`, passwordHash: "x" },
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
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id, betaUser.id);

  await prisma.invoice.create({
    data: { businessId: businessA.id, status: "SENT", total: 125 },
  });
  await prisma.invoice.create({
    data: { businessId: businessB.id, status: "SENT", total: 999 },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      publicToken: `est-a-${randomUUID()}`,
      status: "SENT",
    },
  });

  const beforePreview = await ledgerCount(businessA.id);
  const proposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "CREATE_RECOMMENDATION_ACTION_ITEM",
    targetEntityId: "collect-unpaid-invoices",
    browserBusinessId: businessB.id,
  });
  check("1. preview/propose creates no ledger row", (await ledgerCount(businessA.id)) === beforePreview);
  check("Preview remains unconfirmed", proposal.confirmed === false && proposal.executionResult === null);

  await loadControlledActionCenter(prisma, ownerA);
  await loadControlledAiActionHistory(prisma, ownerA);
  check(
    "2. Action Center / history reads create no ledger row",
    (await ledgerCount(businessA.id)) === beforePreview,
  );

  async function followUpDomain() {
    return {
      items: await prisma.businessActionItem.count({
        where: { businessId: businessA.id, recommendationKey: "follow-up-sent-estimates" },
      }),
      states: await prisma.bsosRecommendationState.count({
        where: { businessId: businessA.id, recommendationKey: "follow-up-sent-estimates" },
      }),
      dismissed: await prisma.bsosRecommendationState.count({
        where: {
          businessId: businessA.id,
          recommendationKey: "follow-up-sent-estimates",
          status: "DISMISSED",
        },
      }),
    };
  }

  const dismissProposalForIdentity = await proposeControlledAction(prisma, ownerA, {
    actionKey: "DISMISS_RECOMMENDATION",
    targetEntityId: "follow-up-sent-estimates",
  });
  const beforeIdentityProofs = await followUpDomain();
  const failedAttemptId = randomUUID();
  let recordedFailedConfirm = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: { ...dismissProposalForIdentity, fingerprint: "stale-before-correction" },
      executionAttemptId: failedAttemptId,
      confirm: "confirm",
    });
  } catch (error) {
    recordedFailedConfirm = error instanceof Error && /stale/i.test(error.message);
  }
  const originalFailedRow = await prisma.controlledAiActionAttempt.findFirst({
    where: {
      businessId: businessA.id,
      executionAttemptId: failedAttemptId,
      actionKey: "DISMISS_RECOMMENDATION",
      recommendationKey: "follow-up-sent-estimates",
    },
  });
  let failedRetryClosed = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: dismissProposalForIdentity,
      executionAttemptId: failedAttemptId,
      confirm: "confirm",
    });
  } catch (error) {
    failedRetryClosed = error instanceof Error && error.message === originalFailedRow?.resultMessage;
  }
  const failedRow = await prisma.controlledAiActionAttempt.findFirst({
    where: {
      businessId: businessA.id,
      executionAttemptId: failedAttemptId,
      actionKey: "DISMISS_RECOMMENDATION",
      recommendationKey: "follow-up-sent-estimates",
    },
  });
  const afterFailedRetry = await followUpDomain();
  check(
    "FAILED attempt stays immutable after the business condition is corrected",
    recordedFailedConfirm &&
      failedRetryClosed &&
      originalFailedRow?.result === "FAILED" &&
      failedRow?.id === originalFailedRow.id &&
      failedRow.result === "FAILED" &&
      failedRow.resultMessage === originalFailedRow.resultMessage &&
      failedRow.confirmedAt.getTime() === originalFailedRow.confirmedAt.getTime() &&
      afterFailedRetry.items === beforeIdentityProofs.items &&
      afterFailedRetry.states === beforeIdentityProofs.states &&
      afterFailedRetry.dismissed === beforeIdentityProofs.dismissed,
  );

  let incompatibleConflictClosed = false;
  try {
    await recordControlledAiAttempt(prisma, ownerA, {
      actionKey: "DISMISS_RECOMMENDATION",
      result: "EXECUTED",
      recommendationKey: "follow-up-sent-estimates",
      targetRecordType: "BsosRecommendationState",
      targetRecordId: "should-not-convert-failed",
      resultCode: "SUCCEEDED",
      resultMessage: "Should not convert FAILED to EXECUTED.",
      executionAttemptId: failedAttemptId,
    });
  } catch (error) {
    incompatibleConflictClosed = error instanceof Error && /different result/i.test(error.message);
  }
  const afterIncompatible = originalFailedRow
    ? await prisma.controlledAiActionAttempt.findFirst({
        where: { id: originalFailedRow.id },
      })
    : null;
  const compatibleReuse = await recordControlledAiAttempt(prisma, ownerA, {
    actionKey: "DISMISS_RECOMMENDATION",
    result: "FAILED",
    recommendationKey: "follow-up-sent-estimates",
    targetRecordType: null,
    targetRecordId: null,
    resultCode: "STALE_PROPOSAL",
    resultMessage: "A later failure write must not overwrite the original FAILED row.",
    executionAttemptId: failedAttemptId,
  });
  check(
    "Unique conflict fails closed when the existing row is semantically incompatible",
    incompatibleConflictClosed &&
      afterIncompatible?.result === "FAILED" &&
      afterIncompatible.resultMessage === originalFailedRow.resultMessage &&
      afterIncompatible.targetRecordId == null &&
      compatibleReuse.id === originalFailedRow.id &&
      compatibleReuse.result === "FAILED" &&
      compatibleReuse.resultMessage === originalFailedRow.resultMessage,
  );

  const deniedAttemptId = randomUUID();
  const deniedMessage = "Owner confirmation was denied for this attempt.";
  const recordedDenied = await recordControlledAiAttempt(prisma, ownerA, {
    actionKey: "DISMISS_RECOMMENDATION",
    result: "DENIED",
    recommendationKey: "follow-up-sent-estimates",
    targetRecordType: null,
    targetRecordId: null,
    resultCode: "DENIED",
    resultMessage: deniedMessage,
    executionAttemptId: deniedAttemptId,
  });
  const originalDeniedRow = await prisma.controlledAiActionAttempt.findFirst({
    where: {
      businessId: businessA.id,
      executionAttemptId: deniedAttemptId,
      actionKey: "DISMISS_RECOMMENDATION",
      recommendationKey: "follow-up-sent-estimates",
    },
  });
  let deniedRetryClosed = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: dismissProposalForIdentity,
      executionAttemptId: deniedAttemptId,
      confirm: "confirm",
    });
  } catch (error) {
    deniedRetryClosed = error instanceof Error && error.message === originalDeniedRow?.resultMessage;
  }
  const deniedRow = await prisma.controlledAiActionAttempt.findFirst({
    where: {
      businessId: businessA.id,
      executionAttemptId: deniedAttemptId,
      actionKey: "DISMISS_RECOMMENDATION",
      recommendationKey: "follow-up-sent-estimates",
    },
  });
  const afterDeniedRetry = await followUpDomain();
  let deniedIncompatibleClosed = false;
  try {
    await recordControlledAiAttempt(prisma, ownerA, {
      actionKey: "DISMISS_RECOMMENDATION",
      result: "EXECUTED",
      recommendationKey: "follow-up-sent-estimates",
      targetRecordType: "BsosRecommendationState",
      targetRecordId: "should-not-convert-denied",
      resultCode: "SUCCEEDED",
      resultMessage: "Should not convert DENIED to EXECUTED.",
      executionAttemptId: deniedAttemptId,
    });
  } catch (error) {
    deniedIncompatibleClosed = error instanceof Error && /different result/i.test(error.message);
  }
  check(
    "DENIED attempt stays immutable after an authorized owner retries the same identity",
    recordedDenied.id === originalDeniedRow?.id &&
      recordedDenied.result === "DENIED" &&
      deniedRetryClosed &&
      deniedIncompatibleClosed &&
      originalDeniedRow?.result === "DENIED" &&
      deniedRow?.id === originalDeniedRow.id &&
      deniedRow.result === "DENIED" &&
      deniedRow.resultMessage === deniedMessage &&
      afterDeniedRetry.items === beforeIdentityProofs.items &&
      afterDeniedRetry.states === beforeIdentityProofs.states,
  );

  const executedSeedId = randomUUID();
  await seedAttempt({
    businessId: businessA.id,
    actionKey: "DISMISS_RECOMMENDATION",
    result: "EXECUTED",
    recommendationKey: "follow-up-sent-estimates",
    membershipId: ownerMem.id,
    userId: ownerUser.id,
    resultCode: "SUCCEEDED",
    resultMessage: "Seeded durable EXECUTED for same-identity retry.",
    executionAttemptId: executedSeedId,
    targetRecordType: "BsosRecommendationState",
  });
  const executedSeedRetry = await confirmControlledAction(prisma, ownerA, {
    proposal: dismissProposalForIdentity,
    executionAttemptId: executedSeedId,
    confirm: "confirm",
  });
  const afterExecutedSeed = await followUpDomain();
  check(
    "Existing EXECUTED attempt retry returns REPLAYED with no second domain write",
    executedSeedRetry.executionResult.status === "REPLAYED" &&
      afterExecutedSeed.items === beforeIdentityProofs.items &&
      afterExecutedSeed.states === beforeIdentityProofs.states &&
      afterExecutedSeed.dismissed === beforeIdentityProofs.dismissed,
  );

  const replayedSeedId = randomUUID();
  await seedAttempt({
    businessId: businessA.id,
    actionKey: "DISMISS_RECOMMENDATION",
    result: "REPLAYED",
    recommendationKey: "follow-up-sent-estimates",
    membershipId: ownerMem.id,
    userId: ownerUser.id,
    resultCode: "REPLAYED",
    resultMessage: "Seeded durable REPLAYED for same-identity retry.",
    executionAttemptId: replayedSeedId,
    targetRecordType: "BsosRecommendationState",
  });
  const replayedSeedRetry = await confirmControlledAction(prisma, ownerA, {
    proposal: dismissProposalForIdentity,
    executionAttemptId: replayedSeedId,
    confirm: "confirm",
  });
  const afterReplayedSeed = await followUpDomain();
  check(
    "Existing REPLAYED attempt retry returns REPLAYED with no second domain write",
    replayedSeedRetry.executionResult.status === "REPLAYED" &&
      afterReplayedSeed.items === beforeIdentityProofs.items &&
      afterReplayedSeed.states === beforeIdentityProofs.states,
  );

  const raceAttemptId = randomUUID();
  const racing = prisma.$extends({
    query: {
      controlledAiActionAttempt: {
        async create({ args }) {
          const data = args.data;
          await prisma.controlledAiActionAttempt.create({
            data: {
              businessId: data.businessId,
              actionKey: data.actionKey,
              result: data.result,
              recommendationKey: data.recommendationKey,
              targetEntityType: data.targetEntityType,
              targetRecordType: data.targetRecordType ?? null,
              targetRecordId: data.targetRecordId ?? null,
              confirmedByMembershipId: data.confirmedByMembershipId,
              confirmedByUserId: data.confirmedByUserId ?? null,
              resultCode: data.resultCode,
              resultMessage: data.resultMessage,
              executionAttemptId: data.executionAttemptId,
              executedAt: data.executedAt ?? new Date(),
            },
          });
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "6.19.3",
            meta: {
              modelName: "ControlledAiActionAttempt",
              target: ["businessId", "executionAttemptId", "actionKey", "recommendationKey"],
            },
          });
        },
      },
    },
  });
  const beforeRace = await followUpDomain();
  const racedConfirm = await confirmControlledAction(racing, ownerA, {
    proposal: dismissProposalForIdentity,
    executionAttemptId: raceAttemptId,
    confirm: "confirm",
  });
  const racedRows = await prisma.controlledAiActionAttempt.findMany({
    where: {
      businessId: businessA.id,
      executionAttemptId: raceAttemptId,
      actionKey: "DISMISS_RECOMMENDATION",
      recommendationKey: "follow-up-sent-estimates",
    },
  });
  const afterRace = await followUpDomain();
  check(
    "Ledger unique race does not create duplicate success or an unprovenanced domain write",
    racedConfirm.executionResult.status === "REPLAYED" &&
      racedRows.length === 1 &&
      racedRows[0].result === "EXECUTED" &&
      afterRace.items === beforeRace.items &&
      afterRace.dismissed === beforeRace.dismissed,
  );

  const freshDismiss = await confirmControlledAction(prisma, ownerA, {
    proposal: dismissProposalForIdentity,
    executionAttemptId: randomUUID(),
    confirm: "confirm",
  });
  const afterFreshDismiss = await followUpDomain();
  check(
    "New executionAttemptId after FAILED/DENIED identities can execute when otherwise valid",
    freshDismiss.executionResult.status === "SUCCEEDED" &&
      afterFreshDismiss.dismissed === 1 &&
      afterFreshDismiss.states === 1,
  );

  const exploding = prisma.$extends({
    query: {
      controlledAiActionAttempt: {
        async create() {
          throw new Error("provenance write failed");
        },
      },
    },
  });
  const atomicAttemptId = randomUUID();
  let atomicFailed = false;
  try {
    await confirmControlledAction(exploding, ownerA, {
      proposal,
      executionAttemptId: atomicAttemptId,
      confirm: "confirm",
    });
  } catch (error) {
    atomicFailed = error instanceof Error && error.message.includes("provenance write failed");
  }
  const afterAtomicFailItems = await prisma.businessActionItem.count({
    where: { businessId: businessA.id, recommendationKey: "collect-unpaid-invoices" },
  });
  const afterAtomicFailLedger = await executedCount(businessA.id, "CREATE_RECOMMENDATION_ACTION_ITEM");
  check(
    "6. success domain write and provenance are atomic",
    atomicFailed && afterAtomicFailItems === 0 && afterAtomicFailLedger === 0,
  );

  const createAttemptId = randomUUID();
  const created = await confirmControlledAction(prisma, ownerA, {
    proposal,
    executionAttemptId: createAttemptId,
    confirm: "confirm",
  });
  const createdItems = await prisma.businessActionItem.findMany({
    where: { businessId: businessA.id, recommendationKey: "collect-unpaid-invoices" },
  });
  const createRows = await prisma.controlledAiActionAttempt.findMany({
    where: {
      businessId: businessA.id,
      actionKey: "CREATE_RECOMMENDATION_ACTION_ITEM",
      result: "EXECUTED",
    },
  });
  check(
    "3. explicit confirmed CREATE produces exactly one domain write + one provenance row",
    created.executionResult.status === "SUCCEEDED" &&
      createdItems.length === 1 &&
      createRows.length === 1 &&
      createRows[0].targetRecordId === createdItems[0].id &&
      createRows[0].targetRecordType === "BusinessActionItem" &&
      createRows[0].recommendationKey === "collect-unpaid-invoices" &&
      createRows[0].confirmedByMembershipId === ownerMem.id &&
      createRows[0].executionAttemptId === createAttemptId,
  );

  const sameAttempt = await confirmControlledAction(prisma, ownerA, {
    proposal,
    executionAttemptId: createAttemptId,
    confirm: "confirm",
  });
  const otherAttempt = await confirmControlledAction(prisma, ownerA, {
    proposal,
    executionAttemptId: randomUUID(),
    confirm: "confirm",
  });
  const afterDupItems = await prisma.businessActionItem.count({
    where: { businessId: businessA.id, recommendationKey: "collect-unpaid-invoices" },
  });
  const afterDupExecuted = await executedCount(businessA.id, "CREATE_RECOMMENDATION_ACTION_ITEM");
  check(
    "7. duplicate confirmation cannot create misleading duplicate success",
    sameAttempt.executionResult.status === "REPLAYED" &&
      otherAttempt.executionResult.status === "REPLAYED" &&
      afterDupItems === 1 &&
      afterDupExecuted === 1,
  );

  const freshDismissRow = await prisma.controlledAiActionAttempt.findFirst({
    where: {
      businessId: businessA.id,
      actionKey: "DISMISS_RECOMMENDATION",
      result: "EXECUTED",
      executionAttemptId: freshDismiss.executionAttemptId,
      recommendationKey: "follow-up-sent-estimates",
    },
  });
  check(
    "4. explicit confirmed DISMISS produces recorded provenance",
    freshDismiss.executionResult.status === "SUCCEEDED" &&
      freshDismissRow?.recommendationKey === "follow-up-sent-estimates" &&
      freshDismissRow.targetRecordType === "BsosRecommendationState" &&
      freshDismissRow.targetRecordId === freshDismiss.executionResult.recordId,
  );

  const completeProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "COMPLETE_RECOMMENDATION",
    targetEntityId: "collect-unpaid-invoices",
  });
  const completed = await confirmControlledAction(prisma, ownerA, {
    proposal: completeProposal,
    executionAttemptId: randomUUID(),
    confirm: "confirm",
  });
  const completeRows = await prisma.controlledAiActionAttempt.findMany({
    where: { businessId: businessA.id, actionKey: "COMPLETE_RECOMMENDATION", result: "EXECUTED" },
  });
  check(
    "5. explicit confirmed COMPLETE produces recorded provenance",
    completed.executionResult.status === "SUCCEEDED" &&
      completeRows.length === 1 &&
      completeRows[0].recommendationKey === "collect-unpaid-invoices",
  );

  const beforeForeign = {
    a: await ledgerCount(businessA.id),
    b: await ledgerCount(businessB.id),
    bItems: await prisma.businessActionItem.count({ where: { businessId: businessB.id } }),
    bStates: await prisma.bsosRecommendationState.count({ where: { businessId: businessB.id } }),
  };
  let foreignRecFailed = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: {
        ...proposal,
        actionKey: "CREATE_RECOMMENDATION_ACTION_ITEM",
        targetEntityId: `foreign-rec-${randomUUID()}`,
      },
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    foreignRecFailed = error instanceof Error && /not active|stale|Choose a live/i.test(error.message);
  }
  check(
    "8. foreign recommendation target fails closed",
    foreignRecFailed &&
      (await ledgerCount(businessB.id)) === beforeForeign.b &&
      (await prisma.businessActionItem.count({ where: { businessId: businessB.id } })) === beforeForeign.bItems,
  );
  const afterForeignRecA = await ledgerCount(businessA.id);
  check(
    "Foreign recommendation probe creates no provenance leak",
    afterForeignRecA === beforeForeign.a && (await ledgerCount(businessB.id)) === beforeForeign.b,
  );

  const followUp = await findCatalogRecommendation(prisma, businessA.id, "follow-up-sent-estimates");
  const foreignItem = await prisma.businessActionItem.create({
    data: {
      businessId: businessB.id,
      recommendationKey: "follow-up-sent-estimates",
      title: "Foreign action item",
    },
  });
  await prisma.bsosRecommendationState.upsert({
    where: {
      businessId_recommendationKey: {
        businessId: businessA.id,
        recommendationKey: "follow-up-sent-estimates",
      },
    },
    create: {
      businessId: businessA.id,
      recommendationKey: "follow-up-sent-estimates",
      status: "OPEN",
      evidenceKey: followUp ? recommendationEvidenceKey(followUp) : "",
      actionItemId: foreignItem.id,
    },
    update: {
      status: "OPEN",
      evidenceKey: followUp ? recommendationEvidenceKey(followUp) : "",
      actionItemId: foreignItem.id,
    },
  });
  const foreignItemProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "CREATE_RECOMMENDATION_ACTION_ITEM",
    targetEntityId: "follow-up-sent-estimates",
  });
  let foreignItemFailed = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: foreignItemProposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    foreignItemFailed = error instanceof Error && /no longer available|stale|not active/i.test(error.message);
  }
  const leakedToB = await prisma.controlledAiActionAttempt.findFirst({
    where: { businessId: businessB.id },
  });
  const rewrittenForeign = await prisma.businessActionItem.findUnique({ where: { id: foreignItem.id } });
  check(
    "9. foreign BusinessActionItem target fails closed",
    foreignItemFailed &&
      !leakedToB &&
      rewrittenForeign?.title === "Foreign action item" &&
      rewrittenForeign.businessId === businessB.id,
  );

  const historyA = await loadControlledAiActionHistory(prisma, ownerA);
  const historyB = await loadControlledAiActionHistory(prisma, ownerB);
  const foreignRead = await loadControlledAiActionAttempt(prisma, ownerB, createRows[0].id);
  const ownedRead = await loadControlledAiActionAttempt(prisma, ownerA, createRows[0].id);
  check(
    "10. foreign attempt cannot be read",
    foreignRead === null &&
      historyB.attempts.length === 0 &&
      !historyB.attempts.some((row) => row.id === createRows[0].id) &&
      ownedRead?.id === createRows[0].id,
  );
  check(
    "Same-business actor name renders",
    ownedRead?.confirmedByName === "Olivia" &&
      historyA.attempts.some((row) => row.id === createRows[0].id && row.confirmedByName === "Olivia"),
  );

  const dirtyAttempt = await seedAttempt({
    businessId: businessA.id,
    actionKey: "CREATE_RECOMMENDATION_ACTION_ITEM",
    result: "EXECUTED",
    recommendationKey: "collect-unpaid-invoices",
    membershipId: betaMem.id,
    userId: betaUser.id,
    resultCode: "SUCCEEDED",
    resultMessage: "Planted foreign actor on a local provenance row.",
    executionAttemptId: randomUUID(),
    targetRecordType: "BusinessActionItem",
    targetRecordId: createdItems[0].id,
  });
  const dirtyHistory = await loadControlledAiActionHistory(prisma, ownerA);
  const dirtyRow = dirtyHistory.attempts.find((row) => row.id === dirtyAttempt.id);
  const dirtyJson = JSON.stringify(dirtyHistory);
  const foreignDirtyRead = await loadControlledAiActionAttempt(prisma, ownerB, dirtyAttempt.id);
  check(
    "Planted foreign Membership does not reveal foreign actor name",
    dirtyRow != null &&
      dirtyRow.confirmedByName === null &&
      !dirtyJson.includes("Bea") &&
      dirtyHistory.attempts.some((row) => row.id === dirtyAttempt.id) &&
      foreignDirtyRead === null,
  );

  let memberConfirmFailed = false;
  try {
    await confirmControlledAction(prisma, memberA, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    memberConfirmFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  let memberHistoryFailed = false;
  try {
    await loadControlledAiActionHistory(prisma, memberA);
  } catch (error) {
    memberHistoryFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check(
    "11. MEMBER cannot manage Controlled AI actions",
    memberConfirmFailed && memberHistoryFailed && !canConfirmControlledActions(memberA),
  );

  const ordinaryItem = await prisma.businessActionItem.create({
    data: {
      businessId: businessA.id,
      recommendationKey: `ordinary-${randomUUID().slice(0, 8)}`,
      title: "Ordinary owner-plan item",
      notes: "Created outside Controlled AI",
      createdByMembershipId: adminMem.id,
    },
  });
  const afterOrdinaryLedger = await prisma.controlledAiActionAttempt.count({
    where: { businessId: businessA.id, targetRecordId: ordinaryItem.id },
  });
  const centerAfterOrdinary = await loadControlledActionCenter(prisma, ownerA);
  const ordinaryCreateRow = centerAfterOrdinary.recordedOwnerPlanState.find(
    (row) => row.recordKind === "ACTION_ITEM" && row.actionItemId === ordinaryItem.id,
  );
  check(
    "12. generic historical BusinessActionItem still remains NOT_RECORDED",
    afterOrdinaryLedger === 0 &&
      ordinaryCreateRow?.origin === ACTION_CENTER_ORIGIN_NOT_RECORDED &&
      !recordedOwnerPlanStateClaimsControlledAction(ordinaryCreateRow) &&
      ordinaryCreateRow?.actionKey == null,
  );

  await upsertRecommendationState(prisma, adminA, {
    recommendationKey: "review-overdue-invoices",
    status: "COMPLETED",
  });
  const ordinaryState = await prisma.bsosRecommendationState.findFirst({
    where: { businessId: businessA.id, recommendationKey: "review-overdue-invoices" },
  });
  const ordinaryStateLedger = ordinaryState
    ? await prisma.controlledAiActionAttempt.count({
        where: { businessId: businessA.id, targetRecordId: ordinaryState.id },
      })
    : 1;
  const ordinaryStateRow = (await loadControlledActionCenter(prisma, ownerA)).recordedOwnerPlanState.find(
    (row) => row.recordKind === "RECOMMENDATION_STATE" && row.targetEntityId === "review-overdue-invoices",
  );
  check(
    "13. generic historical BsosRecommendationState still remains NOT_RECORDED",
    Boolean(ordinaryState) &&
      ordinaryStateLedger === 0 &&
      ordinaryStateRow?.origin === ACTION_CENTER_ORIGIN_NOT_RECORDED &&
      !recordedOwnerPlanStateClaimsControlledAction(ordinaryStateRow),
  );
  check(
    "14. no backfill inference",
    centerAfterOrdinary.recordedOwnerPlanState.every((row) => !recordedOwnerPlanStateClaimsControlledAction(row)) &&
      historyA.attempts.every((row) => CONTROLLED_AI_ATTEMPT_RESULTS.includes(row.result)) &&
      !historyA.attempts.some((row) => row.targetHref && row.targetHref.includes(foreignItem.id)),
  );

  check(
    "15. Business.timezone used for display only",
    historyA.timeZone === "America/Chicago" &&
      ownedRead?.confirmedAtLabel === formatDateTime(createRows[0].confirmedAt, "America/Chicago") &&
      historyB.timeZone === "America/New_York",
  );

  const stored = await prisma.controlledAiActionAttempt.findMany({ where: { businessId: businessA.id } });
  check(
    "16. no prompts/secrets/PII bodies stored in provenance",
    stored.every(
      (row) =>
        !JSON.stringify(row).includes("INJECTED SECRET") &&
        !JSON.stringify(row).toLowerCase().includes("sk-") &&
        !JSON.stringify(row).includes("password") &&
        !Object.keys(row).some((key) => /prompt|secret|payload|messageBody/i.test(key)) &&
        row.resultMessage.length <= 240,
    ),
  );
  check(
    "17. existing allowlist remains unchanged after execution",
    CONTROLLED_ACTION_KEYS.join(",") ===
      "CREATE_RECOMMENDATION_ACTION_ITEM,DISMISS_RECOMMENDATION,COMPLETE_RECOMMENDATION",
  );

  const adminHistory = await loadControlledAiActionHistory(prisma, adminA);
  check(
    "ADMIN can read same-tenant history but cannot confirm",
    adminHistory.attempts.some((row) => row.id === createRows[0].id) && !canConfirmControlledActions(adminA),
  );

  let skippedConfirm = false;
  const beforeSkip = await ledgerCount(businessA.id);
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "no",
    });
  } catch (error) {
    skippedConfirm = error instanceof Error && error.message.includes("Confirm this action explicitly");
  }
  check(
    "Unconfirmed submit creates no ledger row",
    skippedConfirm && (await ledgerCount(businessA.id)) === beforeSkip,
  );

  let foreignTenantFailed = false;
  const beforeForeignTenant = {
    a: await ledgerCount(businessA.id),
    b: await ledgerCount(businessB.id),
  };
  try {
    await confirmControlledAction(prisma, ownerB, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
      browserBusinessId: businessA.id,
    });
  } catch (error) {
    foreignTenantFailed = error instanceof Error && error.message.includes("not for this workspace");
  }
  check(
    "Unauthorized foreign-tenant probe creates no provenance",
    foreignTenantFailed &&
      (await ledgerCount(businessA.id)) === beforeForeignTenant.a &&
      (await ledgerCount(businessB.id)) === beforeForeignTenant.b,
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nControlled AI provenance check failed: ${failures} issue(s).`);
  process.exit(1);
}
console.log("\nControlled AI provenance check passed.");
