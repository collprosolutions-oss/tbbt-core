/**
 * Controlled AI Owner Action Center proofs.
 *
 * Extends Controlled AI Actions V1 without a second engine, schema, or
 * allowlist expansion. Run with:
 *   node --experimental-strip-types scripts/check-controlled-ai-action-center.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError, CAPABILITIES, roleHasCapability } = await import("@/lib/authorization");
const { formatDateTime } = await import("@/lib/format");
const { APP_NAV } = await import("@/lib/nav");
const {
  CONTROLLED_ACTION_CATALOG,
  CONTROLLED_ACTION_KEYS,
  EXCLUDED_ACTION_KEYS,
  actionCenterHref,
  canConfirmControlledActions,
  canViewControlledActionCenter,
  confirmControlledAction,
  executableControlledActionKeys,
  isExcludedActionKey,
  loadControlledActionCenter,
  loadControlledActionCenterItem,
  proposeControlledAction,
  resetControlledActionAttempts,
  resolveOwnedActionTargetLink,
} = await import("@/lib/chief-of-staff");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_controlled_ai_action_center_test";
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

const actionCenterSrc = readRepo("src/lib/chief-of-staff/action-center.ts");
const controlledSrc = readRepo("src/lib/chief-of-staff/controlled-actions.ts");
const actionSrc = readRepo("src/app/actions/ai.ts");
const pageSrc = readRepo("src/app/(app)/actions/page.tsx");
const detailSrc = readRepo("src/app/(app)/actions/[actionId]/page.tsx");
const boardSrc = readRepo("src/components/actions/action-center-board.tsx");
const formSrc = readRepo("src/components/actions/action-center-confirm-form.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const packageSrc = readRepo("package.json");

try {
  console.log("\nSTATIC — Action Center stays on Controlled AI Actions V1");
  check("Executable catalog is still the three owner-plan actions", CONTROLLED_ACTION_KEYS.length === 3);
  check(
    "Allowlist was not expanded",
    CONTROLLED_ACTION_KEYS.join(",") ===
      "CREATE_RECOMMENDATION_ACTION_ITEM,DISMISS_RECOMMENDATION,COMPLETE_RECOMMENDATION",
  );
  check(
    "High-risk exclusions remain non-executable",
    [
      "SEND_CUSTOMER_EMAIL",
      "SEND_CUSTOMER_SMS",
      "CHARGE_CARD",
      "REFUND",
      "MARK_PAID",
      "APPROVE_ESTIMATE",
      "CHANGE_PAYMENT_ACCOUNT",
      "CANCEL_SUBSCRIPTION",
      "MUTATE_VAULT_LEGAL_STATE",
      "CHANGE_PERMISSIONS",
      "SIGN_AGREEMENT",
      "TRANSFER_OWNERSHIP",
    ].every((key) => isExcludedActionKey(key) && !executableControlledActionKeys().includes(key)),
  );
  check(
    "No Prisma action-proposal model or migration was added",
    !schemaSrc.includes("model ControlledAction") &&
      !schemaSrc.includes("AiActionProposal") &&
      !actionCenterSrc.includes("prisma.schema"),
  );
  check(
    "Action Center is a read projection, not a second executor",
    actionCenterSrc.includes("loadCanonicalRecommendationCatalog") &&
      actionCenterSrc.includes("bsosRecommendationState.findMany") &&
      actionCenterSrc.includes("businessActionItem.findMany") &&
      !actionCenterSrc.includes("confirmControlledAction(") &&
      !actionCenterSrc.includes("proposeControlledAction(") &&
      !actionCenterSrc.includes("createActionFromRecommendation(") &&
      !actionCenterSrc.includes("upsertRecommendationState(") &&
      !actionCenterSrc.includes("createInvoice") &&
      !actionCenterSrc.includes("markInvoicePaid") &&
      !actionCenterSrc.includes("runChiefOfStaffCoach"),
  );
  check(
    "Pages use management access and VIEW_REPORTS",
    pageSrc.includes("requireManagementPageAccess()") &&
      pageSrc.includes("CAPABILITIES.VIEW_REPORTS") &&
      detailSrc.includes("requireManagementPageAccess()") &&
      detailSrc.includes("notFound()"),
  );
  check(
    "Owner confirm UI calls the canonical V1 server actions",
    formSrc.includes("proposeCoachActionAction") &&
      formSrc.includes("confirmCoachActionAction") &&
      formSrc.includes('name="confirm" value="confirm"') &&
      formSrc.includes('name="attemptId"') &&
      !formSrc.includes("Approve all") &&
      !formSrc.includes("approve all") &&
      !formSrc.includes("auto-approve") &&
      !formSrc.includes("useEffect(() => { proposeAction"),
  );
  check(
    "Confirm server action still uses confirmControlledAction",
    actionSrc.includes("confirmControlledAction(prisma, access") &&
      actionSrc.includes("proposeControlledAction(prisma, access") &&
      actionSrc.includes('revalidatePath("/actions")'),
  );
  check(
    "Shared nav was not given a parallel Action Center link",
    !APP_NAV.some((item) => item.href === "/actions") && !navSrc.includes('href: "/actions"'),
  );
  check("No npm script was invented for this check", !packageSrc.includes("check-controlled-ai-action-center"));
  check(
    "MEMBER cannot view or confirm",
    !canViewControlledActionCenter({ workspace: { role: "MEMBER" } }) &&
      !canConfirmControlledActions({ workspace: { role: "MEMBER" } }) &&
      !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS),
  );
  check(
    "ADMIN can view but cannot confirm",
    canViewControlledActionCenter({ workspace: { role: "ADMIN" } }) &&
      !canConfirmControlledActions({ workspace: { role: "ADMIN" } }),
  );
  check(
    "OWNER can view and confirm",
    canViewControlledActionCenter({ workspace: { role: "OWNER" } }) &&
      canConfirmControlledActions({ workspace: { role: "OWNER" } }),
  );
  check(
    "Board does not invent a persisted proposal queue",
    boardSrc.includes("No persisted proposal") &&
      boardSrc.includes("Failed confirmations") &&
      pageSrc.includes("loadControlledActionCenter"),
  );
  check(
    "Every catalog row still requires owner confirmation",
    CONTROLLED_ACTION_CATALOG.every((row) => row.approvalClass === "OWNER_CONFIRMED_RECORD"),
  );
  check(
    "Excluded high-risk keys stay listed",
    EXCLUDED_ACTION_KEYS.includes("SEND_CUSTOMER_EMAIL") && EXCLUDED_ACTION_KEYS.includes("MARK_PAID"),
  );

  console.log("\nRUNTIME — tenant isolation, approval, idempotency, and recorded truth");
  resetControlledActionAttempts();

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Action Center",
      slug: `alpha-action-center-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Chicago",
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Action Center",
      slug: `beta-action-center-${randomUUID().slice(0, 8)}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
    },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia", email: `owner-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Avery", email: `admin-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia", email: `member-center-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea", email: `beta-center-${randomUUID()}@example.com`, passwordHash: "x" },
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

  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer" },
  });
  const invoiceA = await prisma.invoice.create({
    data: { businessId: businessA.id, customerId: customerA.id, status: "SENT", total: 125 },
  });
  const invoiceB = await prisma.invoice.create({
    data: { businessId: businessB.id, customerId: customerB.id, status: "SENT", total: 999 },
  });
  const requestA = await prisma.serviceRequest.create({
    data: { businessId: businessA.id, customerId: customerA.id, summary: "Alpha request" },
  });
  const requestB = await prisma.serviceRequest.create({
    data: { businessId: businessB.id, customerId: customerB.id, summary: "Beta request" },
  });
  const estimateA = await prisma.estimate.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      publicToken: `est-a-${randomUUID()}`,
    },
  });
  const jobA = await prisma.job.create({
    data: {
      businessId: businessA.id,
      customerId: customerA.id,
      projectToken: `job-a-${randomUUID()}`,
    },
  });

  const before = await loadControlledActionCenter(prisma, ownerA);
  check(
    "Authenticated owner sees same-tenant live controlled-action target",
    before.needsOwnerConfirmation.some((row) => row.targetEntityId === "collect-unpaid-invoices"),
  );
  check(
    "Live target uses OWNER_CONFIRMED_RECORD and catalog purpose",
    before.needsOwnerConfirmation.some(
      (row) =>
        row.targetEntityId === "collect-unpaid-invoices" &&
        row.availableActions.every((action) => action.approvalClass === "OWNER_CONFIRMED_RECORD") &&
        row.why?.length > 0,
    ),
  );

  const centerBBefore = await loadControlledActionCenter(prisma, ownerB);
  check(
    "Foreign tenant action items do not appear before any confirm",
    centerBBefore.recordedResults.length === 0,
  );

  let memberLoadFailed = false;
  try {
    await loadControlledActionCenter(prisma, memberA);
  } catch (error) {
    memberLoadFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("MEMBER cannot load the Action Center", memberLoadFailed);

  const adminCenter = await loadControlledActionCenter(prisma, adminA);
  check(
    "ADMIN can read same-tenant live targets but the UI confirm gate stays owner-only",
    adminCenter.needsOwnerConfirmation.some((row) => row.targetEntityId === "collect-unpaid-invoices") &&
      !canConfirmControlledActions(adminA),
  );

  const proposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "CREATE_RECOMMENDATION_ACTION_ITEM",
    targetEntityId: "collect-unpaid-invoices",
    browserBusinessId: businessB.id,
  });
  check("Propose does not create a recorded Action Center result", (await loadControlledActionCenter(prisma, ownerA)).recordedResults.length === 0);

  let skippedConfirm = false;
  try {
    await confirmControlledAction(prisma, ownerA, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "no",
    });
  } catch (error) {
    skippedConfirm = error instanceof Error && error.message.includes("Confirm this action explicitly");
  }
  check("Action requiring approval cannot execute before explicit confirm", skippedConfirm);
  check(
    "Rejected confirm does not become a successful recorded result",
    (await loadControlledActionCenter(prisma, ownerA)).recordedResults.length === 0,
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
  check("MEMBER cannot gain owner confirm authority", memberConfirmFailed);

  let adminConfirmFailed = false;
  try {
    await confirmControlledAction(prisma, adminA, {
      proposal,
      executionAttemptId: randomUUID(),
      confirm: "confirm",
    });
  } catch (error) {
    adminConfirmFailed = error instanceof ForbiddenError || error?.name === "ForbiddenError";
  }
  check("ADMIN cannot confirm via the canonical V1 mechanism", adminConfirmFailed);

  const attemptId = randomUUID();
  const otherAttemptId = randomUUID();
  const [first, concurrent] = await Promise.all([
    confirmControlledAction(prisma, ownerA, {
      proposal,
      executionAttemptId: attemptId,
      confirm: "confirm",
    }),
    confirmControlledAction(prisma, ownerA, {
      proposal,
      executionAttemptId: otherAttemptId,
      confirm: "confirm",
    }),
  ]);
  const createdItems = await prisma.businessActionItem.findMany({
    where: { businessId: businessA.id, recommendationKey: "collect-unpaid-invoices" },
  });
  check(
    "Owner execution uses the canonical V1 executor",
    first.executionResult.recordType === "BusinessActionItem" &&
      createdItems.length === 1 &&
      first.executionResult.message.includes("did not execute the work"),
  );
  check(
    "Duplicate/concurrent execution preserves V1 idempotency",
    createdItems.length === 1 &&
      first.executionResult.recordId === concurrent.executionResult.recordId &&
      [first.executionResult.status, concurrent.executionResult.status].includes("SUCCEEDED") &&
      [first.executionResult.status, concurrent.executionResult.status].includes("REPLAYED"),
  );

  const after = await loadControlledActionCenter(prisma, ownerA);
  const recordedCreate = after.recordedResults.find(
    (row) => row.actionKey === "CREATE_RECOMMENDATION_ACTION_ITEM" && row.targetEntityId === "collect-unpaid-invoices",
  );
  check("Successful action reflects the persisted successful result", Boolean(recordedCreate) && recordedCreate.actionItemId === createdItems[0].id);
  check(
    "Recorded timestamp uses Business.timezone",
    recordedCreate?.recordedAtLabel === formatDateTime(createdItems[0].updatedAt, "America/Chicago"),
  );

  const sameAttempt = await confirmControlledAction(prisma, ownerA, {
    proposal,
    executionAttemptId: attemptId,
    confirm: "confirm",
  });
  check(
    "Repeat confirm of the same one-time operation stays idempotent",
    sameAttempt.executionResult.status === "REPLAYED" &&
      (await prisma.businessActionItem.count({
        where: { businessId: businessA.id, recommendationKey: "collect-unpaid-invoices" },
      })) === 1,
  );

  const centerB = await loadControlledActionCenter(prisma, ownerB);
  check(
    "Foreign tenant recorded action does not appear",
    !centerB.recordedResults.some((row) => row.actionItemId === createdItems[0].id) &&
      !centerB.recordedResults.some((row) => row.id === createdItems[0].id),
  );

  const foreignDetail = await loadControlledActionCenterItem(prisma, ownerB, createdItems[0].id);
  check("Direct foreign action ID fails closed", foreignDetail === null);

  const ownedDetail = await loadControlledActionCenterItem(prisma, ownerA, createdItems[0].id);
  check(
    "Same-tenant action item detail resolves",
    ownedDetail?.recordedResults.some((row) => row.actionItemId === createdItems[0].id) === true,
  );

  const unknownDetail = await loadControlledActionCenterItem(prisma, ownerA, `missing-${randomUUID()}`);
  check("Unknown action ID fails closed", unknownDetail === null);

  const ownedCustomer = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "CUSTOMER",
    id: customerA.id,
  });
  const foreignCustomer = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "CUSTOMER",
    id: customerB.id,
  });
  const ownedInvoice = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "INVOICE",
    id: invoiceA.id,
  });
  const foreignInvoice = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "INVOICE",
    id: invoiceB.id,
  });
  const ownedRequest = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "REQUEST",
    id: requestA.id,
  });
  const foreignRequest = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "REQUEST",
    id: requestB.id,
  });
  const ownedJob = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "JOB",
    id: jobA.id,
  });
  const ownedEstimate = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "ESTIMATE",
    id: estimateA.id,
  });
  const unknownType = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "BANK_ACCOUNT",
    id: customerA.id,
  });
  const recommendationLink = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "RECOMMENDATION",
    id: "collect-unpaid-invoices",
  });
  const foreignRecommendation = await resolveOwnedActionTargetLink(prisma, ownerA, {
    type: "RECOMMENDATION",
    id: `not-a-recommendation-${randomUUID()}`,
  });
  check(
    "Target link requires a same-tenant owned record",
    ownedCustomer?.href === `/customers/${customerA.id}` &&
      foreignCustomer === null &&
      ownedInvoice?.href === `/invoices/${invoiceA.id}` &&
      foreignInvoice === null &&
      ownedRequest?.href === `/requests/${requestA.id}` &&
      foreignRequest === null &&
      ownedJob?.href === `/jobs/${jobA.id}` &&
      ownedEstimate?.href === `/estimates/${estimateA.id}` &&
      unknownType === null &&
      recommendationLink?.href === actionCenterHref("collect-unpaid-invoices") &&
      foreignRecommendation === null,
  );

  const staleProposal = await proposeControlledAction(prisma, ownerA, {
    actionKey: "DISMISS_RECOMMENDATION",
    targetEntityId: "collect-unpaid-invoices",
  });
  await prisma.invoice.create({
    data: { businessId: businessA.id, customerId: customerA.id, status: "SENT", total: 40 },
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
  const afterStale = await loadControlledActionCenter(prisma, ownerA);
  check("Failure remains failure — stale confirm is not recorded as success", staleFailed);
  check(
    "Stale failure does not add a dismissed recorded result",
    !afterStale.recordedResults.some((row) => row.actionKey === "DISMISS_RECOMMENDATION"),
  );

  const currentDismiss = await proposeControlledAction(prisma, ownerA, {
    actionKey: "DISMISS_RECOMMENDATION",
    targetEntityId: "collect-unpaid-invoices",
  });
  const dismissed = await confirmControlledAction(prisma, ownerA, {
    proposal: currentDismiss,
    executionAttemptId: randomUUID(),
    confirm: "confirm",
  });
  const afterDismiss = await loadControlledActionCenter(prisma, ownerA);
  check(
    "Persisted dismiss result is shown as DISMISSED",
    dismissed.executionResult.status === "SUCCEEDED" &&
      afterDismiss.recordedResults.some(
        (row) => row.actionKey === "DISMISS_RECOMMENDATION" && row.recordedStatus === "DISMISSED",
      ),
  );
  check(
    "No new allowed action types were introduced by execution",
    CONTROLLED_ACTION_KEYS.length === 3 &&
      afterDismiss.catalog.every((row) => CONTROLLED_ACTION_KEYS.includes(row.actionKey)),
  );

  let excludedFailed = false;
  try {
    await proposeControlledAction(prisma, ownerA, {
      actionKey: "SEND_CUSTOMER_EMAIL",
      targetEntityId: "collect-unpaid-invoices",
    });
  } catch (error) {
    excludedFailed = error instanceof Error && error.message.includes("not executable");
  }
  check("Action Center cannot propose an excluded high-risk action", excludedFailed);

  check(
    "Detail href stays on the Action Center route",
    actionCenterHref("collect-unpaid-invoices") === "/actions/collect-unpaid-invoices",
  );
} catch (error) {
  console.error(error);
  failures += 1;
} finally {
  await prisma.$disconnect();
}

if (failures > 0) {
  console.error(`\nAction Center check failed: ${failures} issue(s).`);
  process.exit(1);
}
console.log("\nAction Center check passed.");
