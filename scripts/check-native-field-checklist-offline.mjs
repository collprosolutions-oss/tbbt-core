/**
 * Native assigned-job checklist local drafts + explicit sync.
 *
 * Reuses JobCrewVisit.checklistJson. Proves local draft/reload, explicit
 * sync, stale/reassigned refusal, authorization, and tenant isolation.
 * Does not complete jobs, write time, or send messages.
 *
 * Run with:
 *   npm run test:native-field-checklist-offline
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { setCleaningVisitCadence } = await import("@/lib/cleaning-visit-ops");
const {
  packCrewChecklist,
  serializeChecklist,
  toggleChecklistItem,
} = await import("@/lib/cleaning-visit-workflow");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob } = await import("@/lib/native-field");
const {
  NATIVE_CHECKLIST_CHOOSE_ITEM,
  NATIVE_CHECKLIST_NO_ITEMS_MESSAGE,
  NATIVE_CHECKLIST_STALE_MESSAGE,
  NATIVE_CHECKLIST_SYNC_JSON_MAX_BYTES,
  parseNativeChecklistSyncJson,
  syncNativeAssignedChecklistDraft,
} = await import("@/lib/native-field-checklist");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const {
  checklistDraftStorageKey,
  createMemoryChecklistDraftStorage,
  loadChecklistDraft,
  overlayChecklistDraft,
  persistLocalChecklistChange,
  recordLocalChecklistChange,
} = await import(new URL("../apps/native/src/checklist-drafts.ts", import.meta.url));

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_native_field_checklist_offline_test";
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
  console.error("Failed to push schema for native-field checklist offline test database.");
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

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function makeOwnerAccess(businessId, membershipId, userId) {
  return {
    businessId,
    workspace: {
      role: "OWNER",
      membership: { id: membershipId },
      user: { id: userId, email: "owner@native-checklist-offline.example", name: "Owner" },
      business: { id: businessId, name: "Offline Checklist Co", timezone: "America/New_York" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

const checklistOpsSrc = readRepo("src/lib/native-field-checklist.ts");
const checklistSyncRouteSrc = readRepo(
  "src/app/api/native/v1/jobs/[jobId]/checklist/sync/route.ts",
);
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const checklistSectionSrc = readRepo("apps/native/src/screens/JobChecklistSection.tsx");
const draftSrc = readRepo("apps/native/src/checklist-drafts.ts");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");

console.log("\nSTATIC — Local drafts, explicit sync, and Job-screen isolation");
check(
  "Draft sync reuses JobCrewVisit.checklistJson, assignment lock, and expected-state recheck",
  checklistOpsSrc.includes("syncNativeAssignedChecklistDraft") &&
    checklistOpsSrc.includes("lockTenantOwnedJob") &&
    checklistOpsSrc.includes("assignedMembershipId") &&
    checklistOpsSrc.includes("NATIVE_CHECKLIST_STALE_MESSAGE") &&
    checklistOpsSrc.includes("parseChecklistJson(lockedVisit?.checklistJson)") &&
    checklistOpsSrc.includes("jobCrewVisit.update") &&
    checklistOpsSrc.includes("toggleChecklistItem") &&
    !checklistOpsSrc.includes("completeJobWithRunningTimeSafetyInTransaction") &&
    !checklistOpsSrc.includes("startAssignedActivityTimeInTransaction") &&
    !checklistSyncRouteSrc.includes("cookies(") &&
    checklistSyncRouteSrc.includes("readBearerToken") &&
    checklistSyncRouteSrc.includes("syncNativeAssignedChecklistDraft"),
);
check(
  "Sync is trade-neutral when the Job already has checklist items",
  checklistOpsSrc.includes("trade-neutral") &&
    !checklistOpsSrc.includes("requireAssignedCleaningJob") &&
    !checklistOpsSrc.includes("assertCleaningJob") &&
    docsSrc.includes("trade-neutral when the Job already has checklist items"),
);
check(
  "Native checklist UI records locally, marks unsynced, and syncs only on tap",
  checklistSectionSrc.includes("Unsynced checklist changes") &&
    checklistSectionSrc.includes("Sync checklist") &&
    checklistSectionSrc.includes("persistLocalChecklistChange") &&
    checklistSectionSrc.includes("syncNativeJobChecklistDraft") &&
    !checklistSectionSrc.includes("completeNativeJob") &&
    !checklistSectionSrc.includes("startNativeJob") &&
    !checklistSectionSrc.includes("startNativeActivityTime") &&
    !checklistSectionSrc.includes("recordNativeJobVisit") &&
    !checklistSectionSrc
      .slice(
        checklistSectionSrc.indexOf("useEffect"),
        checklistSectionSrc.indexOf("if (!source)"),
      )
      .includes("syncNativeJobChecklistDraft") &&
    jobScreenSrc.includes("JobChecklistSection") &&
    !jobScreenSrc.includes("recordNativeJobChecklistItem") &&
    nativeApiSrc.includes("/checklist/sync") &&
    draftSrc.includes("createMemoryChecklistDraftStorage"),
);
check(
  "Docs describe explicit sync, stale refusal, and the dedicated check",
  docsSrc.includes("Unsynced") &&
    docsSrc.includes("Sync checklist") &&
    docsSrc.includes("refuses a stale or reassigned draft") &&
    docsSrc.includes("does not background-write") &&
    docsSrc.includes("test:native-field-checklist-offline"),
);

const emptySync = parseNativeChecklistSyncJson("{}");
const kitchenExpected = packCrewChecklist().map((item) => ({
  key: item.key,
  checked: item.checked,
}));
const validSync = parseNativeChecklistSyncJson(
  JSON.stringify({
    expectedChecklist: kitchenExpected,
    items: [{ itemKey: "kitchen", checked: true }],
  }),
);
check(
  "Sync JSON requires expectedChecklist plus at least one item change",
  emptySync.ok === false &&
    emptySync.error === NATIVE_CHECKLIST_CHOOSE_ITEM &&
    validSync.ok === true &&
    validSync.items[0].itemKey === "kitchen" &&
    validSync.items[0].checked === true &&
    validSync.expectedChecklist.length === kitchenExpected.length,
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/checklist/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_CHECKLIST_SYNC_JSON_MAX_BYTES + 1),
  }),
  NATIVE_CHECKLIST_SYNC_JSON_MAX_BYTES,
);
check(
  "Oversized checklist sync JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

console.log("\nLOCAL — Draft persist, reload, and overlay");
const scope = {
  businessId: "biz-a",
  membershipId: "mem-a",
  jobId: "job-a",
};
const otherScope = {
  businessId: "biz-b",
  membershipId: "mem-a",
  jobId: "job-a",
};
const shared = new Map();
const storageA = createMemoryChecklistDraftStorage(shared);
const storageReload = createMemoryChecklistDraftStorage(shared);
const serverItems = packCrewChecklist();
const first = await persistLocalChecklistChange(storageA, {
  scope,
  serverItems,
  itemKey: "kitchen",
  checked: true,
});
const reloaded = await loadChecklistDraft(storageReload, scope);
const otherTenant = await loadChecklistDraft(storageReload, otherScope);
const overlay = overlayChecklistDraft(serverItems, reloaded);
const reverted = recordLocalChecklistChange({
  scope,
  serverItems,
  draft: reloaded,
  itemKey: "kitchen",
  checked: false,
});
check(
  "Assigned worker can record a local kitchen draft",
  first?.items.length === 1 &&
    first.items[0].itemKey === "kitchen" &&
    first.items[0].checked === true &&
    first.expectedChecklist.find((item) => item.key === "kitchen")?.checked === false,
);
check(
  "Reloading the same scoped store keeps the unsynced draft",
  reloaded?.items[0].itemKey === "kitchen" &&
    reloaded.items[0].checked === true &&
    overlay.find((item) => item.key === "kitchen")?.checked === true &&
    overlay.find((item) => item.key === "bathrooms")?.checked === false,
);
check(
  "Another business scope cannot read the draft",
  otherTenant === null &&
    checklistDraftStorageKey(scope) !== checklistDraftStorageKey(otherScope),
);
check(
  "Toggling back to the server state clears the local draft",
  reverted === null,
);

try {
  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };
  const password = "native-checklist-offline-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Checklist Offline",
      slug: `alpha-native-checklist-off-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Checklist Offline",
      slug: `beta-native-checklist-off-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Checklist Offline",
      slug: `blocked-native-checklist-off-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const handyBusiness = await prisma.business.create({
    data: {
      name: "Handy Native Checklist Offline",
      slug: `handy-native-checklist-off-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-checklist-offline.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-checklist-offline.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-checklist-offline.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-checklist-offline.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-checklist-offline.example`,
      passwordHash,
    },
  });
  const handyUser = await prisma.user.create({
    data: {
      name: "Handy Member",
      email: `handy-${randomUUID()}@native-checklist-offline.example`,
      passwordHash,
    },
  });

  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const otherMem = await prisma.membership.create({
    data: { userId: otherUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "MEMBER" },
  });
  const blockedMem = await prisma.membership.create({
    data: { userId: blockedUser.id, businessId: blockedBusiness.id, role: "MEMBER" },
  });
  const handyMem = await prisma.membership.create({
    data: { userId: handyUser.id, businessId: handyBusiness.id, role: "MEMBER" },
  });

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: handyBusiness.id,
      status: "active",
      planCode: "FOUNDER",
      legacyExempt: true,
    },
  });
  const endedTrial = new Date(Date.now() - 60_000);
  await prisma.businessSaasSubscription.create({
    data: {
      businessId: blockedBusiness.id,
      status: "canceled",
      planCode: "FOUNDER",
      legacyExempt: false,
      trialStartedAt: new Date(endedTrial.getTime() - 14 * 24 * 60 * 60 * 1000),
      trialEndsAt: endedTrial,
      founderEligibilityEndedAt: endedTrial,
    },
  });

  const ownerA = makeOwnerAccess(businessA.id, ownerMem.id, ownerUser.id);

  async function createTradeJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName ?? `${input.tradeCode} Customer`,
        email: `${input.tradeCode}-${randomUUID().slice(0, 8)}@native-checklist-offline.example`,
        phone: "555-0142",
      },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        description: `${input.tradeCode} checklist offline`,
        tradeCode: input.tradeCode,
        serviceIntent: "ONE_TIME",
      },
    });
    const estimate = await prisma.estimate.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        serviceRequestId: request.id,
        status: "APPROVED",
        publicToken: randomUUID(),
        total: 140,
      },
    });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        estimateId: estimate.id,
        projectToken: randomUUID(),
        status: input.status ?? "IN_PROGRESS",
        scheduledAt: new Date("2026-09-28T14:00:00.000Z"),
        assignedMembershipId: input.assignedMembershipId,
      },
    });
  }

  const memberJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
    customerName: "Cara Canary Offline Checklist",
  });
  const ownerJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: ownerMem.id,
  });
  const otherJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: otherMem.id,
  });
  const betaJob = await createTradeJob({
    businessId: businessB.id,
    tradeCode: "CLEANING",
    assignedMembershipId: betaMem.id,
  });
  const raceJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const staleJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const blockedJob = await createTradeJob({
    businessId: blockedBusiness.id,
    tradeCode: "CLEANING",
    assignedMembershipId: blockedMem.id,
  });
  const handyBareJob = await createTradeJob({
    businessId: handyBusiness.id,
    tradeCode: "HANDYMAN",
    assignedMembershipId: handyMem.id,
  });
  const handyListedJob = await createTradeJob({
    businessId: handyBusiness.id,
    tradeCode: "HANDYMAN",
    assignedMembershipId: handyMem.id,
  });

  for (const job of [memberJob, ownerJob, otherJob, raceJob, staleJob]) {
    await setCleaningVisitCadence(prisma, ownerA, { jobId: job.id, cadence: "WEEKLY" });
  }
  await prisma.jobCrewVisit.create({
    data: {
      businessId: handyBusiness.id,
      jobId: handyListedJob.id,
      checklistJson: serializeChecklist(packCrewChecklist()),
    },
  });
  await prisma.jobCrewVisit.create({
    data: {
      businessId: blockedBusiness.id,
      jobId: blockedJob.id,
      checklistJson: serializeChecklist(packCrewChecklist()),
    },
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
    password,
  });
  const ownerSignIn = await signInNativeField(prisma, {
    email: ownerUser.email,
    password,
  });
  const otherSignIn = await signInNativeField(prisma, {
    email: otherUser.email,
    password,
  });
  const betaSignIn = await signInNativeField(prisma, {
    email: betaUser.email,
    password,
  });
  const blockedSignIn = await signInNativeField(prisma, {
    email: blockedUser.email,
    password,
  });
  const handySignIn = await signInNativeField(prisma, {
    email: handyUser.email,
    password,
  });
  if (
    !memberSignIn.ok ||
    !ownerSignIn.ok ||
    !otherSignIn.ok ||
    !betaSignIn.ok ||
    !blockedSignIn.ok ||
    !handySignIn.ok
  ) {
    throw new Error("Native checklist offline fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const ownerAccess = await resolveNativeFieldAccess(prisma, { token: ownerSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  const blockedAccess = await resolveNativeFieldAccess(prisma, { token: blockedSignIn.token });
  const handyAccess = await resolveNativeFieldAccess(prisma, { token: handySignIn.token });
  if (
    !memberAccess.ok ||
    !ownerAccess.ok ||
    !otherAccess.ok ||
    !betaAccess.ok ||
    !blockedAccess.ok ||
    !handyAccess.ok
  ) {
    throw new Error("Native checklist offline fixture access failed.");
  }

  function expectedFrom(jobDetail) {
    const items = jobDetail.checklist?.items ?? jobDetail.visit?.checklist ?? [];
    return items.map((item) => ({ key: item.key, checked: item.checked }));
  }

  console.log("\nLIVE — Authorization, tenant isolation, and trade-neutral items");

  const memberDetail = await loadNativeAssignedJob(prisma, memberAccess.access, memberJob.id);
  const handyBareDetail = await loadNativeAssignedJob(
    prisma,
    handyAccess.access,
    handyBareJob.id,
  );
  const handyListedDetail = await loadNativeAssignedJob(
    prisma,
    handyAccess.access,
    handyListedJob.id,
  );
  check(
    "Assigned Cleaning job returns trade-neutral checklist items",
    memberDetail?.checklist?.items.some((item) => item.key === "kitchen" && item.checked === false) ===
      true,
  );
  check(
    "Handyman job without checklist items does not expose a checklist",
    handyBareDetail?.checklist == null && handyBareDetail?.visit == null,
  );
  check(
    "Handyman job with checklist items exposes those items without a Cleaning visit",
    handyListedDetail?.checklist?.items.some(
      (item) => item.key === "kitchen" && item.checked === false,
    ) === true && handyListedDetail?.visit == null,
  );

  const expectedMember = expectedFrom(memberDetail);
  const ownerOnMember = await syncNativeAssignedChecklistDraft(
    prisma,
    ownerAccess.access,
    memberJob.id,
    {
      expectedChecklist: expectedMember,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const memberOnOwner = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    ownerJob.id,
    {
      expectedChecklist: expectedMember,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const stolen = await syncNativeAssignedChecklistDraft(
    prisma,
    otherAccess.access,
    memberJob.id,
    {
      expectedChecklist: expectedMember,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const cross = await syncNativeAssignedChecklistDraft(
    prisma,
    betaAccess.access,
    memberJob.id,
    {
      expectedChecklist: expectedMember,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const handyBareWrite = await syncNativeAssignedChecklistDraft(
    prisma,
    handyAccess.access,
    handyBareJob.id,
    {
      expectedChecklist: expectedMember,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const blockedWrite = await syncNativeAssignedChecklistDraft(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    {
      expectedChecklist: expectedFrom({
        checklist: { items: packCrewChecklist() },
        visit: null,
      }),
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const memberAfterAuth = await prisma.jobCrewVisit.findFirst({
    where: { jobId: memberJob.id, businessId: businessA.id },
  });
  check(
    "Unassigned OWNER cannot sync a checklist draft on a MEMBER job",
    ownerOnMember.ok === false &&
      ownerOnMember.status === 404 &&
      ownerOnMember.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Unassigned MEMBER cannot sync a checklist draft on an OWNER job",
    memberOnOwner.ok === false &&
      memberOnOwner.status === 404 &&
      memberOnOwner.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Another worker cannot sync a checklist draft on this job",
    stolen.ok === false && stolen.status === 404 && stolen.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Cross-tenant worker cannot sync a checklist draft",
    cross.ok === false && cross.status === 404 && cross.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Handyman job without checklist items refuses sync",
    handyBareWrite.ok === false &&
      handyBareWrite.status === 409 &&
      handyBareWrite.error === NATIVE_CHECKLIST_NO_ITEMS_MESSAGE,
  );
  check(
    "Checklist sync requires an operating SaaS subscription",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  check(
    "Failed authorization leaves the assigned checklist unchecked",
    JSON.parse(memberAfterAuth.checklistJson).every((item) => item.checked === false),
  );

  console.log("\nLIVE — Explicit sync, stale conflict, reassignment, and Handyman items");

  const memberSync = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    memberJob.id,
    {
      expectedChecklist: expectedMember,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const memberReloaded = await loadNativeAssignedJob(prisma, memberAccess.access, memberJob.id);
  check(
    "Assigned MEMBER can sync a kitchen draft",
    memberSync.ok === true &&
      memberSync.alreadySynced === false &&
      memberSync.job.checklist?.items.find((item) => item.key === "kitchen")?.checked === true &&
      memberSync.job.checklist?.items.find((item) => item.key === "bathrooms")?.checked === false,
  );
  check(
    "Reloaded assigned job shows the synced MEMBER checklist progress",
    memberReloaded?.checklist?.items.find((item) => item.key === "kitchen")?.checked === true &&
      memberReloaded?.checklist?.items.find((item) => item.key === "bathrooms")?.checked === false,
  );

  const ownerDetail = await loadNativeAssignedJob(prisma, ownerAccess.access, ownerJob.id);
  const ownerSync = await syncNativeAssignedChecklistDraft(
    prisma,
    ownerAccess.access,
    ownerJob.id,
    {
      expectedChecklist: expectedFrom(ownerDetail),
      items: [{ itemKey: "floors", checked: true }],
    },
  );
  check(
    "Assigned OWNER can sync a floors draft",
    ownerSync.ok === true &&
      ownerSync.job.checklist?.items.find((item) => item.key === "floors")?.checked === true,
  );

  const handySync = await syncNativeAssignedChecklistDraft(
    prisma,
    handyAccess.access,
    handyListedJob.id,
    {
      expectedChecklist: expectedFrom(handyListedDetail),
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const handyReloaded = await loadNativeAssignedJob(
    prisma,
    handyAccess.access,
    handyListedJob.id,
  );
  check(
    "Assigned Handyman worker can sync when the Job already has checklist items",
    handySync.ok === true &&
      handySync.job.checklist?.items.find((item) => item.key === "kitchen")?.checked === true &&
      handyReloaded?.checklist?.items.find((item) => item.key === "kitchen")?.checked === true &&
      handyReloaded?.visit == null,
  );

  const staleExpected = expectedFrom(await loadNativeAssignedJob(prisma, memberAccess.access, staleJob.id));
  await prisma.jobCrewVisit.update({
    where: { jobId: staleJob.id },
    data: {
      checklistJson: serializeChecklist(
        toggleChecklistItem(packCrewChecklist(), "bathrooms", true),
      ),
    },
  });
  const staleSync = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    staleJob.id,
    {
      expectedChecklist: staleExpected,
      items: [{ itemKey: "kitchen", checked: true }],
    },
  );
  const staleAfter = await prisma.jobCrewVisit.findFirst({
    where: { jobId: staleJob.id, businessId: businessA.id },
  });
  check(
    "Stale draft fails visibly and does not overwrite newer checklist work",
    staleSync.ok === false &&
      staleSync.status === 409 &&
      staleSync.error === NATIVE_CHECKLIST_STALE_MESSAGE &&
      JSON.parse(staleAfter.checklistJson).find((item) => item.key === "bathrooms")?.checked ===
        true &&
      JSON.parse(staleAfter.checklistJson).find((item) => item.key === "kitchen")?.checked ===
        false,
  );

  const raceExpected = expectedFrom(await loadNativeAssignedJob(prisma, memberAccess.access, raceJob.id));
  const race = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    raceJob.id,
    {
      expectedChecklist: raceExpected,
      items: [{ itemKey: "kitchen", checked: true }],
    },
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceJob.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const raceVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: raceJob.id, businessId: businessA.id },
  });
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  check(
    "Assignment change after the initial read refuses the checklist sync",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves no checklist write",
    JSON.parse(raceVisit.checklistJson).every((item) => item.checked === false) &&
      raceJobAfter?.assignedMembershipId === otherMem.id,
  );

  const leftoverB = await prisma.jobCrewVisit.findMany({ where: { businessId: businessB.id } });
  const leftoverA = await prisma.jobCrewVisit.findMany({ where: { businessId: businessA.id } });
  check(
    "Synced checklist records stay isolated by businessId",
    leftoverB.length === 0 &&
      leftoverA.every((row) => row.businessId === businessA.id) &&
      leftoverA.some(
        (row) =>
          row.jobId === memberJob.id &&
          JSON.parse(row.checklistJson).find((item) => item.key === "kitchen")?.checked === true,
      ) &&
      leftoverA.some(
        (row) =>
          row.jobId === ownerJob.id &&
          JSON.parse(row.checklistJson).find((item) => item.key === "floors")?.checked === true,
      ),
  );

  const unusedBeta = await loadNativeAssignedJob(prisma, betaAccess.access, betaJob.id);
  const unusedOther = await loadNativeAssignedJob(prisma, otherAccess.access, otherJob.id);
  check(
    "Unsynced fixtures were never written by failed cross-tenant or unassigned syncs",
    unusedBeta === null || unusedOther?.checklist?.items.every((item) => item.checked === false),
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - live native checklist offline sync", error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nNative field checklist offline check passed: local drafts, explicit sync, conflicts, auth, and isolation held."
    : `\n${failures} native field checklist offline check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
