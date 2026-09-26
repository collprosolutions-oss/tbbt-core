/**
 * Controlled AI Actions V1 proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-controlled-actions.mjs
 */
import { register } from "node:module";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, roleHasCapability } = await import("@/lib/authorization");
const { ProductCapabilityRequiredError } = await import("@/lib/product-entitlements");
const { PRODUCT_CAPABILITIES } = await import("@/lib/product-catalog");
const {
  CONTROLLED_ACTION_CATALOG,
  CONTROLLED_ACTION_KEYS,
  EXCLUDED_ACTION_KEYS,
  confirmControlledAction,
  executableControlledActionKeys,
  findCatalogRecommendation,
  isExcludedActionKey,
  loadCanonicalRecommendationCatalog,
  parseControlledActionProposal,
  proposeControlledAction,
  resetControlledActionAttempts,
  runChiefOfStaffCoach,
  serializeControlledActionProposal,
  synthesizeCoachAnswer,
} = await import("@/lib/chief-of-staff");
const { createActionFromRecommendation } = await import("@/lib/bsos-actions");
const { interpretFinancialSpecialist } = await import("@/lib/chief-of-staff/specialists/financial");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_controlled_actions_test";
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

async function domainCounts(businessId) {
  return {
    actionItems: await prisma.businessActionItem.count({ where: { businessId } }),
    recommendationStates: await prisma.bsosRecommendationState.count({ where: { businessId } }),
    invoices: await prisma.invoice.count({ where: { businessId } }),
    payments: await prisma.payment.count({ where: { businessId } }),
    comms: await prisma.customerCommunication.count({ where: { businessId } }),
    purchaseOrders: await prisma.materialPurchaseOrder.count({ where: { businessId } }),
    agreements: await prisma.businessAgreement.count({ where: { businessId } }),
    completedJobs: await prisma.job.count({ where: { businessId, status: "COMPLETED" } }),
  };
}

function sameCounts(before, after) {
  return Object.keys(before).every((key) => before[key] === after[key]);
}

const controlledSrc = readFileSync(new URL("../src/lib/chief-of-staff/controlled-actions.ts", import.meta.url), "utf8");
const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
const synthesizeSrc = readFileSync(new URL("../src/lib/chief-of-staff/synthesize.ts", import.meta.url), "utf8");
const typesSrc = readFileSync(new URL("../src/lib/chief-of-staff/types.ts", import.meta.url), "utf8");
const actionSrc = readFileSync(new URL("../src/app/actions/ai.ts", import.meta.url), "utf8");
const schemaSrc = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const confirmUiSrc = readFileSync(new URL("../src/components/bsos/confirm-action-form.tsx", import.meta.url), "utf8");
const coachFormSrc = readFileSync(new URL("../src/components/bsos/coach-form.tsx", import.meta.url), "utf8");
const specialistFiles = [
  readFileSync(new URL("../src/lib/chief-of-staff/specialists/financial.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/chief-of-staff/growth-specialist.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/chief-of-staff/workforce-specialist.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/chief-of-staff/materials-specialist.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/chief-of-staff/communications-specialist.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/chief-of-staff/knowledge-launch-specialist.ts", import.meta.url), "utf8"),
  readFileSync(new URL("../src/lib/chief-of-staff/business-protection-specialist.ts", import.meta.url), "utf8"),
];
const registrySrc = readFileSync(new URL("../src/lib/chief-of-staff/registry.ts", import.meta.url), "utf8");

try {
  console.log("\nSTATIC — Controlled AI Actions V1 contract");
  check("Executable catalog is the four owner-plan actions", CONTROLLED_ACTION_KEYS.length === 4);
  check(
    "High-consequence exclusions stay listed",
    EXCLUDED_ACTION_KEYS.includes("SEND_CUSTOMER_EMAIL") &&
      EXCLUDED_ACTION_KEYS.includes("SEND_CUSTOMER_SMS") &&
      EXCLUDED_ACTION_KEYS.includes("MAKE_PHONE_CALL") &&
      EXCLUDED_ACTION_KEYS.includes("CHANGE_CONSENT") &&
      EXCLUDED_ACTION_KEYS.includes("CHARGE_CARD") &&
      EXCLUDED_ACTION_KEYS.includes("REFUND") &&
      EXCLUDED_ACTION_KEYS.includes("MARK_PAID") &&
      EXCLUDED_ACTION_KEYS.includes("SUPPLIER_PURCHASE") &&
      EXCLUDED_ACTION_KEYS.includes("COMMIT_PURCHASE_ORDER") &&
      EXCLUDED_ACTION_KEYS.includes("AUTHORIZE_PAYROLL") &&
      EXCLUDED_ACTION_KEYS.includes("CANCEL_SUBSCRIPTION") &&
      EXCLUDED_ACTION_KEYS.includes("OFFBOARD_EXPORT_DELETE") &&
      EXCLUDED_ACTION_KEYS.includes("PUBLISH_WEBSITE") &&
      EXCLUDED_ACTION_KEYS.includes("SIGN_AGREEMENT") &&
      EXCLUDED_ACTION_KEYS.includes("COMPLETE_AGREEMENT") &&
      EXCLUDED_ACTION_KEYS.includes("MUTATE_VAULT_LEGAL_STATE") &&
      EXCLUDED_ACTION_KEYS.includes("CHANGE_PERMISSIONS") &&
      EXCLUDED_ACTION_KEYS.includes("CHANGE_ROLE") &&
      EXCLUDED_ACTION_KEYS.includes("TRANSFER_OWNERSHIP"),
  );
  check(
    "Excluded keys are not executable",
    EXCLUDED_ACTION_KEYS.every((key) => !executableControlledActionKeys().includes(key) && isExcludedActionKey(key)),
  );
  check(
    "Every catalog row is OWNER_CONFIRMED_RECORD and calls an existing op",
    CONTROLLED_ACTION_CATALOG.every(
      (row) =>
        row.approvalClass === "OWNER_CONFIRMED_RECORD" &&
        row.requiredRoleCapability === CAPABILITIES.VIEW_REPORTS &&
        row.requiredProductCapability === PRODUCT_CAPABILITIES.REPORTING_INSIGHTS &&
        ["createActionFromRecommendation", "upsertRecommendationState", "updateBusinessActionStatus"].includes(
          row.canonicalOperation,
        ),
    ),
  );
  check(
    "Wrapper calls the existing domain functions, not a second writer",
    controlledSrc.includes("createActionFromRecommendation(") &&
      controlledSrc.includes("upsertRecommendationState(") &&
      controlledSrc.includes("updateBusinessActionStatus(") &&
      !controlledSrc.includes("prisma.invoice") &&
      !controlledSrc.includes("markInvoicePaid") &&
      !controlledSrc.includes("composeCustomerCommunication") &&
      !controlledSrc.includes("publishWebsite") &&
      !controlledSrc.includes("authorizePayrollRun"),
  );
  check("No AiActionProposal model", !schemaSrc.includes("AiActionProposal") && !typesSrc.includes("AiActionProposal"));
  check(
    "Coach ask, runner, and synthesis cannot confirm",
    !runSrc.includes("confirmControlledAction") &&
      !runSrc.includes("proposeControlledAction") &&
      !synthesizeSrc.includes("confirmControlledAction") &&
      !synthesizeSrc.includes("proposeControlledAction") &&
      !coachFormSrc.includes("confirmCoachActionAction"),
  );
  check(
    "Specialists still cannot propose or execute",
    specialistFiles.every(
      (src) =>
        !src.includes("confirmControlledAction") &&
        !src.includes("proposeControlledAction") &&
        !src.includes("createActionFromRecommendation("),
    ) && registrySrc.includes("propose-ai-action"),
  );
  check(
    "Confirm server action requires product entitlement and explicit confirm",
    actionSrc.includes("confirmCoachActionAction") &&
      actionSrc.includes("requireOperatingProductAccess") &&
      actionSrc.includes("REPORTING_INSIGHTS") &&
      confirmUiSrc.includes('name="confirm" value="confirm"') &&
      confirmUiSrc.includes("Owner confirm") &&
      !confirmUiSrc.includes("useEffect(() => { proposeAction"),
  );
  check("MEMBER remains blocked from VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));

  console.log("\nRUNTIME — propose does nothing; confirm is owner-only and stale-safe");
  resetControlledActionAttempts();

  const businessA = await prisma.business.create({
    data: { name: "Alpha Actions", slug: `alpha-actions-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Actions", slug: `beta-actions-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-actions-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery", email: `admin-actions-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-actions-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-actions-${randomUUID()}@example.com`, passwordHash: "x" },
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

  const invoice = await prisma.invoice.create({
    data: { businessId: businessA.id, status: "SENT", total: 125 },
  });
  await prisma.invoice.create({
    data: { businessId: businessB.id, status: "SENT", total: 999 },
  });

  const recommendation = await findCatalogRecommendation(prisma, businessA.id, "collect-unpaid-invoices");
  check("Live catalog has collect-unpaid-invoices for tenant A", Boolean(recommendation));

  const beforePropose = await domainCounts(businessA.id);
  const proposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "CREATE_RECOMMENDATION_ACTION",
    targetEntityId: "collect-unpaid-invoices",
    browserBusinessId: businessB.id,
  });
  const afterPropose = await domainCounts(businessA.id);
  check("Proposal does nothing before confirmation", sameCounts(beforePropose, afterPropose));
  check("Proposal is not confirmed and has no execution result", proposal.confirmed === false && proposal.executionResult === null);
  check("Browser businessId cannot retarget the proposal", proposal.businessId === businessA.id);
  check("Proposal serializes without becoming executable", parseControlledActionProposal(serializeControlledActionProposal(proposal))?.confirmed === false);

  let excludedFailed = false;
  try {
    await proposeControlledAction(prisma, ownerA, {
      actionKey: "SEND_CUSTOMER_EMAIL",
      targetEntityId: "collect-unpaid-invoices",
    });
  } catch (error) {
    excludedFailed = error instanceof Error && error.message.includes("not executable");
  }
  check("Customer email stays non-executable", excludedFailed);
  const afterExcluded = await domainCounts(businessA.id);
  check("Excluded propose writes nothing", sameCounts(afterPropose, afterExcluded));

  for (const key of ["MARK_PAID", "PUBLISH_WEBSITE", "AUTHORIZE_PAYROLL", "TRANSFER_OWNERSHIP"]) {
    let refused = false;
    try {
      await confirmControlledAction(prisma, ownerA, {
        proposal: { ...proposal, actionKey: key },
        executionAttemptId: randomUUID(),
        confirm: "confirm",
      });
    } catch (error) {
      refused = error instanceof Error && error.message.includes("not executable");
    }
    check(`${key} remains non-executable`, refused);
  }
  check("Excluded confirm writes nothing", sameCounts(afterExcluded, await domainCounts(businessA.id)));

  let memberFailed = false;
  try {
    await confirmControlledAction(prisma, memberA, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    memberFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  let memberProposeFailed = false;
  try {
    await proposeControlledAction(prisma, memberA, {
      actionKey: "CREATE_RECOMMENDATION_ACTION",
      targetEntityId: "collect-unpaid-invoices",
    });
  } catch (error) {
    memberProposeFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("MEMBER cannot propose management actions", memberProposeFailed);
  check("MEMBER cannot confirm management actions", memberFailed);
  check("MEMBER confirm writes nothing", sameCounts(afterExcluded, await domainCounts(businessA.id)));

  let adminFailed = false;
  try {
    await confirmControlledAction(prisma, adminA, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    adminFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("ADMIN cannot confirm via the Coach path", adminFailed);

  const humanCreated = await createActionFromRecommendation(prisma, adminA, recommendation);
  check("ADMIN can still use the canonical human operation", Boolean(humanCreated.id));
  await prisma.businessActionItem.delete({ where: { id: humanCreated.id } });

  let foreignFailed = false;
  try {
    await confirmControlledAction(prisma, ownerB, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
      browserBusinessId: businessA.id,
    });
  } catch (error) {
    foreignFailed = error instanceof Error && error.message.includes("not for this workspace");
  }
  check("Foreign tenant target fails closed", foreignFailed);
  check("Foreign confirm does not write tenant A", sameCounts(await domainCounts(businessA.id), afterExcluded) || (await domainCounts(businessA.id)).actionItems === afterExcluded.actionItems);

  const staleProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "DISMISS_RECOMMENDATION",
    targetEntityId: "collect-unpaid-invoices",
  });
  const beforeStale = await domainCounts(businessA.id);
  await prisma.invoice.create({
    data: { businessId: businessA.id, status: "SENT", total: 50 },
  });
  let staleFailed = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: staleProposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    staleFailed = error instanceof Error && error.message.includes("stale");
  }
  check("Stale proposal fails before mutation", staleFailed);
  const afterStale = await domainCounts(businessA.id);
  check("Stale confirm does not dismiss or create rows", afterStale.recommendationStates === beforeStale.recommendationStates && afterStale.actionItems === beforeStale.actionItems);

  const currentProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "CREATE_RECOMMENDATION_ACTION",
    targetEntityId: "collect-unpaid-invoices",
  });
  const beforeSuccess = await domainCounts(businessA.id);
  const attemptId = randomUUID();
  const first = await confirmControlledAction(prisma, ownerA, {
    proposal: currentProposal,
    executionAttemptId: attemptId,
    confirm: "confirm",
  });
  const afterSuccess = await domainCounts(businessA.id);
  check("Current proposal succeeds through the canonical operation", first.executionResult.status === "SUCCEEDED" && afterSuccess.actionItems === beforeSuccess.actionItems + 1);
  check("Canonical create message is preserved", first.executionResult.message.includes("did not execute the work"));

  const replay = await confirmControlledAction(prisma, ownerA, {
    proposal: currentProposal,
    executionAttemptId: attemptId,
    confirm: "confirm",
  });
  const afterReplay = await domainCounts(businessA.id);
  check("Duplicate execution attempt is idempotent", replay.executionResult.status === "REPLAYED" && afterReplay.actionItems === afterSuccess.actionItems);
  check("Replay returns the same record", replay.executionResult.recordId === first.executionResult.recordId);

  const concurrentAttempt = randomUUID();
  const concurrentProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "COMPLETE_RECOMMENDATION",
    targetEntityId: "collect-unpaid-invoices",
  });
  const [one, two] = await Promise.all([
    confirmControlledAction(prisma, ownerA, {
      proposal: concurrentProposal,
      executionAttemptId: concurrentAttempt,
      confirm: "confirm",
    }),
    confirmControlledAction(prisma, ownerA, {
      proposal: concurrentProposal,
      executionAttemptId: concurrentAttempt,
      confirm: "confirm",
    }),
  ]);
  const completedState = await prisma.bsosRecommendationState.findFirst({
    where: { businessId: businessA.id, recommendationKey: "collect-unpaid-invoices" },
  });
  check(
    "Concurrent confirms share one execution attempt",
    completedState?.status === "COMPLETED" &&
      one.executionResult.recordId === two.executionResult.recordId &&
      [one.executionResult.status, two.executionResult.status].includes("SUCCEEDED") &&
      [one.executionResult.status, two.executionResult.status].includes("REPLAYED"),
  );

  let missingConfirm = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: currentProposal,
      executionAttemptId: randomUUID(),
      confirm: "yes",
    });
  } catch (error) {
    missingConfirm = error instanceof Error && error.message.includes("explicitly");
  }
  check("A non-confirm token is not owner confirmation", missingConfirm);

  let productFailed = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: await proposeControlledAction(prisma, ownerA, {
        actionKey: "DISMISS_RECOMMENDATION",
        targetEntityId: "collect-unpaid-invoices",
      }),
      executionAttemptId: randomUUID(),
      confirm: "confirm",
      test: { denyProductCapabilities: [PRODUCT_CAPABILITIES.REPORTING_INSIGHTS] },
    });
  } catch (error) {
    productFailed = error instanceof ProductCapabilityRequiredError || error?.name === "ProductCapabilityRequiredError";
  }
  check("Canonical product entitlement still applies", productFailed);

  let roleDenied = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal: await proposeControlledAction(prisma, ownerA, {
        actionKey: "CREATE_RECOMMENDATION_ACTION",
        targetEntityId: "collect-unpaid-invoices",
      }),
      executionAttemptId: randomUUID(),
      confirm: "confirm",
      test: { denyRoleCapabilities: [CAPABILITIES.VIEW_REPORTS] },
    });
  } catch (error) {
    roleDenied = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("Canonical role authorization still applies", roleDenied);

  const existingItem = await createActionFromRecommendation(
    prisma,
    ownerA,
    await findCatalogRecommendation(prisma, businessA.id, "collect-unpaid-invoices"),
  );
  const statusProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "UPDATE_ACTION_ITEM_STATUS",
    targetEntityId: existingItem.id,
    parameters: { nextStatus: "DONE" },
  });
  const statusResult = await confirmControlledAction(prisma, ownerA, {
    proposal: statusProposal,
    executionAttemptId: randomUUID(),
    confirm: "confirm",
  });
  const updated = await prisma.businessActionItem.findUnique({ where: { id: existingItem.id } });
  check("Action-item status confirm uses the canonical updater", statusResult.executionResult.recordId === existingItem.id && updated.status === "DONE");

  const catalog = await loadCanonicalRecommendationCatalog(prisma, businessA.id);
  const specialist = interpretFinancialSpecialist(catalog, "Create an action and mark the invoice paid", {
    recommendationKey: "collect-unpaid-invoices",
  });
  check("Financial specialist still only explains", specialist.status === "OK" || specialist.status === "SKIPPED");
  const synthesis = synthesizeCoachAnswer({
    question: "Create the unpaid invoice action and email the customer",
    catalog,
    specialistResults: [specialist],
    conflicts: { items: [], uniqueRecommendationKeys: [] },
    coachContext: {
      facts: catalog.facts,
      recommendations: catalog.activeRecommendations,
      metrics: [],
      goals: [],
      actionItems: [],
    },
    plannerSkipped: [],
  });
  check("Synthesis does not return an executable proposal", !("executionResult" in (synthesis.output ?? {})));

  const beforeCoach = await domainCounts(businessA.id);
  await runChiefOfStaffCoach(prisma, ownerA, {
    question: "Create an action for unpaid invoices, text the customer, mark paid, and publish the website.",
    attemptId: randomUUID(),
  });
  const afterCoach = await domainCounts(businessA.id);
  check("Coach ask is not autonomous execution", afterCoach.actionItems === beforeCoach.actionItems);
  check("Coach ask does not send communications", afterCoach.comms === beforeCoach.comms);
  check("Coach ask does not create payments", afterCoach.payments === beforeCoach.payments);
  check("Coach ask does not publish or purchase", afterCoach.purchaseOrders === beforeCoach.purchaseOrders && afterCoach.agreements === beforeCoach.agreements);
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0 ? `\nAll controlled-action checks passed.` : `\n${failures} controlled-action check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
