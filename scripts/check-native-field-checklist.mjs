/**
 * Native assigned-job Cleaning checklist progress — reuse the canonical
 * checklist write, OWNER/MEMBER assignment isolation, duplicate taps,
 * and reassignment races.
 *
 * Imports the REAL production helpers from src/lib/native-field.ts and
 * src/lib/native-field-checklist.ts. Uses a disposable sibling Postgres
 * database (`tbbt_native_field_checklist_test`).
 *
 * Run with:
 *   npm run test:native-field-checklist
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { CLEANING_VISIT_ONLY_MESSAGE } = await import("@/lib/cleaning-visit-workflow");
const { setCleaningVisitCadence } = await import("@/lib/cleaning-visit-ops");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob } = await import("@/lib/native-field");
const {
  NATIVE_CHECKLIST_CHOOSE_ITEM,
  NATIVE_CHECKLIST_JSON_MAX_BYTES,
  parseNativeChecklistItemJson,
  recordNativeAssignedChecklistItem,
} = await import("@/lib/native-field-checklist");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

const testDbName = "tbbt_native_field_checklist_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native-field checklist test database.");
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
      user: { id: userId, email: "owner@native-checklist.example", name: "Owner" },
      business: { id: businessId, name: "Checklist Co", timezone: "America/New_York" },
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
const membershipGuardSrc = readRepo("src/lib/exact-active-membership.ts");
const visitLibSrc = readRepo("src/lib/native-field.ts");
const canonicalOpsSrc = readRepo("src/lib/cleaning-visit-ops.ts");
const checklistRouteSrc = readRepo(
  "src/app/api/native/v1/jobs/[jobId]/checklist/route.ts",
);
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const checklistSectionSrc = readRepo("apps/native/src/screens/JobChecklistSection.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const canonicalChecklistSrc = canonicalOpsSrc.slice(
  canonicalOpsSrc.indexOf("export async function setAssignedChecklistItem"),
  canonicalOpsSrc.indexOf("export async function recordAssignedVisitOutcome"),
);

console.log("\nSTATIC — Canonical checklist write, lock recheck, and Job-screen reload");
check(
  "Native checklist write reuses setAssignedChecklistItem and assigned-job scope",
  checklistOpsSrc.includes("setAssignedChecklistItem") &&
    checklistOpsSrc.includes("nativeAssignedJobWhere") &&
    checklistOpsSrc.includes("afterInitialRead") &&
    checklistOpsSrc.includes("requireSaasOperatingEntitlement") &&
    checklistRouteSrc.includes("recordNativeAssignedChecklistItem") &&
    checklistOpsSrc.includes("syncNativeAssignedChecklistDraft") &&
    !checklistOpsSrc.includes("job.create("),
);
check(
  "Canonical checklist write locks, rechecks assignment, and re-reads before persist",
  canonicalChecklistSrc.includes("lockTenantOwnedJob") &&
    canonicalChecklistSrc.includes("assignedMembershipId") &&
    canonicalChecklistSrc.includes("afterInitialRead") &&
    canonicalChecklistSrc.includes("exactActiveMembershipHeld") &&
    canonicalChecklistSrc.indexOf("lockTenantOwnedJob") <
      canonicalChecklistSrc.indexOf("jobCrewVisit.update") &&
    canonicalChecklistSrc.indexOf("locked.assignedMembershipId") <
      canonicalChecklistSrc.indexOf("jobCrewVisit.update") &&
    canonicalChecklistSrc.indexOf("exactActiveMembershipHeld") <
      canonicalChecklistSrc.indexOf("jobCrewVisit.update") &&
    canonicalChecklistSrc.indexOf("parseChecklistJson(lockedVisit.checklistJson)") <
      canonicalChecklistSrc.indexOf("jobCrewVisit.update"),
);
check(
  "Exact active membership guard locks THIS membership in THIS business",
  membershipGuardSrc.includes('FROM "Membership"') &&
    membershipGuardSrc.includes("FOR UPDATE") &&
    membershipGuardSrc.includes("actor.membershipId") &&
    membershipGuardSrc.includes('actor.businessId') &&
    !membershipGuardSrc.includes("userId"),
);
check(
  "Native checklist route uses Bearer helpers, caps JSON, and never uses cookies()",
  checklistRouteSrc.includes("readBearerToken") &&
    checklistRouteSrc.includes("readCappedRequestText") &&
    checklistRouteSrc.includes("parseNativeChecklistItemJson") &&
    !checklistRouteSrc.includes("cookies("),
);
check(
  "Native checklist JSON is capped at 4 KB",
  checklistOpsSrc.includes("NATIVE_CHECKLIST_JSON_MAX_BYTES = 4096") &&
    NATIVE_CHECKLIST_JSON_MAX_BYTES === 4096,
);
check(
  "Native Job screen records checklist progress and reloads it",
  jobScreenSrc.includes("JobChecklistSection") &&
    jobScreenSrc.includes("reloadAssignedJob") &&
    checklistSectionSrc.includes("Mark done") &&
    checklistSectionSrc.includes("Crew checklist") &&
    nativeApiSrc.includes("/checklist") &&
    nativeTypesSrc.includes("checklist:") &&
    visitLibSrc.includes("checklist: view.checklist"),
);
check(
  "Docs describe assignment-scoped checklist progress and the dedicated check",
  docsSrc.includes("Crew checklist") &&
    docsSrc.includes("setAssignedChecklistItem") &&
    docsSrc.includes("test:native-field-checklist"),
);
check(
  "Native checklist write is assignment-scoped for OWNER and MEMBER",
  docsSrc.includes("OWNER and MEMBER can both record progress only when the job is assigned to them"),
);

const emptyJson = parseNativeChecklistItemJson("{}");
const missingChecked = parseNativeChecklistItemJson('{"itemKey":"kitchen"}');
const kitchenJson = parseNativeChecklistItemJson('{"itemKey":"kitchen","checked":true}');
const bathroomsJson = parseNativeChecklistItemJson(
  '{"itemKey":"bathrooms","checked":false}',
);
check(
  "Checklist JSON accepts itemKey plus a boolean checked flag",
  emptyJson.ok === false &&
    emptyJson.error === NATIVE_CHECKLIST_CHOOSE_ITEM &&
    missingChecked.ok === false &&
    kitchenJson.ok === true &&
    kitchenJson.itemKey === "kitchen" &&
    kitchenJson.checked === true &&
    bathroomsJson.ok === true &&
    bathroomsJson.checked === false,
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/checklist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_CHECKLIST_JSON_MAX_BYTES + 1),
  }),
  NATIVE_CHECKLIST_JSON_MAX_BYTES,
);
check(
  "Oversized checklist JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
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
  const password = "native-checklist-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Checklist",
      slug: `alpha-native-checklist-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Checklist",
      slug: `beta-native-checklist-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Checklist",
      slug: `blocked-native-checklist-${randomUUID()}`,
      tradeCode: "CLEANING",
      ...completedOnboarding,
    },
  });
  const handyBusiness = await prisma.business.create({
    data: {
      name: "Handy Native Checklist",
      slug: `handy-native-checklist-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-checklist.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-checklist.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-checklist.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-checklist.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-checklist.example`,
      passwordHash,
    },
  });
  const handyUser = await prisma.user.create({
    data: {
      name: "Handy Member",
      email: `handy-${randomUUID()}@native-checklist.example`,
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
        email: `${input.tradeCode}-${randomUUID().slice(0, 8)}@native-checklist.example`,
        phone: "555-0142",
      },
    });
    const request = await prisma.serviceRequest.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        description: `${input.tradeCode} checklist`,
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
    customerName: "Cara Canary Native Checklist",
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
  const duplicateJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const blockedJob = await createTradeJob({
    businessId: blockedBusiness.id,
    tradeCode: "CLEANING",
    assignedMembershipId: blockedMem.id,
  });
  const handyJob = await createTradeJob({
    businessId: handyBusiness.id,
    tradeCode: "HANDYMAN",
    assignedMembershipId: handyMem.id,
  });

  for (const job of [memberJob, ownerJob, otherJob, raceJob, duplicateJob]) {
    await setCleaningVisitCadence(prisma, ownerA, { jobId: job.id, cadence: "WEEKLY" });
  }

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
  check(
    "Assigned MEMBER and assigned OWNER can sign in",
    memberSignIn.ok === true && ownerSignIn.ok === true,
  );
  if (
    !memberSignIn.ok ||
    !ownerSignIn.ok ||
    !otherSignIn.ok ||
    !betaSignIn.ok ||
    !blockedSignIn.ok ||
    !handySignIn.ok
  ) {
    throw new Error("Native checklist fixture sign-in failed.");
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
    throw new Error("Native checklist fixture access failed.");
  }

  console.log("\nLIVE — OWNER/MEMBER authorization, tenant isolation, and Handyman refusal");

  const memberDetail = await loadNativeAssignedJob(prisma, memberAccess.access, memberJob.id);
  const ownerDetail = await loadNativeAssignedJob(prisma, ownerAccess.access, ownerJob.id);
  const ownerOnMember = await loadNativeAssignedJob(prisma, ownerAccess.access, memberJob.id);
  const memberOnOwner = await loadNativeAssignedJob(prisma, memberAccess.access, ownerJob.id);
  const otherDetail = await loadNativeAssignedJob(prisma, memberAccess.access, otherJob.id);
  const betaDetail = await loadNativeAssignedJob(prisma, memberAccess.access, betaJob.id);
  const handyDetail = await loadNativeAssignedJob(prisma, handyAccess.access, handyJob.id);
  check(
    "Assigned MEMBER sees the unchecked crew checklist on their job",
    memberDetail?.visit?.eligible === true &&
      memberDetail.visit.checklist.some((item) => item.key === "kitchen" && item.checked === false) &&
      memberDetail.visit.checklist.length === 6,
  );
  check(
    "Assigned OWNER sees the unchecked crew checklist on their job",
    ownerDetail?.visit?.eligible === true &&
      ownerDetail.visit.checklist.some((item) => item.key === "kitchen" && item.checked === false),
  );
  check(
    "OWNER and MEMBER cannot read each other's assigned jobs",
    ownerOnMember === null && memberOnOwner === null && otherDetail === null && betaDetail === null,
  );
  check("Handyman assigned job does not return a Cleaning visit payload", handyDetail?.visit == null);

  const ownerOnMemberWrite = await recordNativeAssignedChecklistItem(
    prisma,
    ownerAccess.access,
    memberJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const memberOnOwnerWrite = await recordNativeAssignedChecklistItem(
    prisma,
    memberAccess.access,
    ownerJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const stolen = await recordNativeAssignedChecklistItem(
    prisma,
    otherAccess.access,
    memberJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const cross = await recordNativeAssignedChecklistItem(
    prisma,
    betaAccess.access,
    memberJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const handyWrite = await recordNativeAssignedChecklistItem(
    prisma,
    handyAccess.access,
    handyJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const blockedWrite = await recordNativeAssignedChecklistItem(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const memberAfterAuth = await prisma.jobCrewVisit.findFirst({
    where: { jobId: memberJob.id, businessId: businessA.id },
  });
  const ownerAfterAuth = await prisma.jobCrewVisit.findFirst({
    where: { jobId: ownerJob.id, businessId: businessA.id },
  });
  check(
    "Unassigned OWNER cannot record checklist progress on a MEMBER job",
    ownerOnMemberWrite.ok === false &&
      ownerOnMemberWrite.status === 404 &&
      ownerOnMemberWrite.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Unassigned MEMBER cannot record checklist progress on an OWNER job",
    memberOnOwnerWrite.ok === false &&
      memberOnOwnerWrite.status === 404 &&
      memberOnOwnerWrite.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Another worker cannot record checklist progress on this job",
    stolen.ok === false && stolen.status === 404 && stolen.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Cross-tenant worker cannot record checklist progress",
    cross.ok === false && cross.status === 404 && cross.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Handyman assigned job refuses the Cleaning checklist write",
    handyWrite.ok === false &&
      handyWrite.status === 409 &&
      handyWrite.error === CLEANING_VISIT_ONLY_MESSAGE,
  );
  check(
    "Checklist write requires an operating SaaS subscription",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  check(
    "Failed authorization leaves both assigned checklists unchecked",
    JSON.parse(memberAfterAuth.checklistJson).every((item) => item.checked === false) &&
      JSON.parse(ownerAfterAuth.checklistJson).every((item) => item.checked === false),
  );

  console.log("\nLIVE — Recorded progress, reload, duplicate taps, and reassignment race");

  const memberWrite = await recordNativeAssignedChecklistItem(
    prisma,
    memberAccess.access,
    memberJob.id,
    { itemKey: "kitchen", checked: true },
  );
  const memberReloaded = await loadNativeAssignedJob(prisma, memberAccess.access, memberJob.id);
  check(
    "Assigned MEMBER can record kitchen progress",
    memberWrite.ok === true &&
      memberWrite.alreadyRecorded === false &&
      memberWrite.job.visit?.checklist.find((item) => item.key === "kitchen")?.checked === true &&
      memberWrite.job.visit?.checklist.find((item) => item.key === "bathrooms")?.checked === false,
  );
  check(
    "Reloaded assigned job shows the MEMBER checklist progress",
    memberReloaded?.visit?.checklist.find((item) => item.key === "kitchen")?.checked === true &&
      memberReloaded?.visit?.checklist.find((item) => item.key === "bathrooms")?.checked === false,
  );

  const ownerWrite = await recordNativeAssignedChecklistItem(
    prisma,
    ownerAccess.access,
    ownerJob.id,
    { itemKey: "floors", checked: true },
  );
  const ownerReloaded = await loadNativeAssignedJob(prisma, ownerAccess.access, ownerJob.id);
  check(
    "Assigned OWNER can record floors progress and see it after reload",
    ownerWrite.ok === true &&
      ownerWrite.alreadyRecorded === false &&
      ownerWrite.job.visit?.checklist.find((item) => item.key === "floors")?.checked === true &&
      ownerReloaded?.visit?.checklist.find((item) => item.key === "floors")?.checked === true &&
      ownerReloaded?.visit?.checklist.find((item) => item.key === "kitchen")?.checked === false,
  );

  const memberUnknown = await recordNativeAssignedChecklistItem(
    prisma,
    memberAccess.access,
    memberJob.id,
    { itemKey: "not-a-pack-item", checked: true },
  );
  check(
    "Unknown checklist item is refused and does not change recorded progress",
    memberUnknown.ok === false &&
      memberUnknown.status === 409 &&
      memberUnknown.error === "That checklist item is not on this visit." &&
      (await loadNativeAssignedJob(prisma, memberAccess.access, memberJob.id))?.visit?.checklist.find(
        (item) => item.key === "kitchen",
      )?.checked === true,
  );

  const repeatKitchen = await recordNativeAssignedChecklistItem(
    prisma,
    memberAccess.access,
    memberJob.id,
    { itemKey: "kitchen", checked: true },
  );
  check(
    "Duplicate tap of the same checklist item is a successful no-op",
    repeatKitchen.ok === true &&
      repeatKitchen.alreadyRecorded === true &&
      repeatKitchen.job.visit?.checklist.find((item) => item.key === "kitchen")?.checked === true,
  );

  const [dupA, dupB] = await Promise.all([
    recordNativeAssignedChecklistItem(
      prisma,
      memberAccess.access,
      duplicateJob.id,
      { itemKey: "kitchen", checked: true },
    ),
    recordNativeAssignedChecklistItem(
      prisma,
      memberAccess.access,
      duplicateJob.id,
      { itemKey: "kitchen", checked: true },
    ),
  ]);
  const duplicateVisits = await prisma.jobCrewVisit.findMany({
    where: { jobId: duplicateJob.id, businessId: businessA.id },
  });
  check(
    "Concurrent duplicate taps both succeed and leave one checked kitchen item",
    dupA.ok === true &&
      dupB.ok === true &&
      duplicateVisits.length === 1 &&
      JSON.parse(duplicateVisits[0].checklistJson).find((item) => item.key === "kitchen")
        ?.checked === true,
  );

  const race = await recordNativeAssignedChecklistItem(
    prisma,
    memberAccess.access,
    raceJob.id,
    { itemKey: "kitchen", checked: true },
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
    "Assignment change after the initial read refuses the checklist tap",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves no checklist write",
    JSON.parse(raceVisit.checklistJson).every((item) => item.checked === false) &&
      raceJobAfter?.assignedMembershipId === otherMem.id,
  );

  const deactivateUser = await prisma.user.create({
    data: {
      name: "Deactivate Checklist Worker",
      email: `deactivate-${randomUUID()}@native-checklist.example`,
      passwordHash,
    },
  });
  const deactivateMem = await prisma.membership.create({
    data: { userId: deactivateUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const deactivateSignIn = await signInNativeField(prisma, {
    email: deactivateUser.email,
    password,
  });
  if (!deactivateSignIn.ok) {
    throw new Error("Deactivation checklist fixture sign-in failed.");
  }
  const deactivateAccess = await resolveNativeFieldAccess(prisma, {
    token: deactivateSignIn.token,
  });
  if (!deactivateAccess.ok) {
    throw new Error("Deactivation checklist fixture access failed.");
  }
  const deactivateJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: deactivateMem.id,
    customerName: "Deactivate Checklist Canary",
  });
  await setCleaningVisitCadence(prisma, ownerA, { jobId: deactivateJob.id, cadence: "WEEKLY" });
  const deactivate = await recordNativeAssignedChecklistItem(
    prisma,
    deactivateAccess.access,
    deactivateJob.id,
    { itemKey: "kitchen", checked: true },
    {
      afterInitialRead: async () => {
        const otherClient = new PrismaClient({ datasourceUrl: testUrl });
        try {
          await otherClient.membership.update({
            where: { id: deactivateMem.id },
            data: { active: false },
          });
        } finally {
          await otherClient.$disconnect();
        }
      },
    },
  );
  const deactivateVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: deactivateJob.id, businessId: businessA.id },
  });
  const deactivateJobAfter = await prisma.job.findFirst({
    where: { id: deactivateJob.id, businessId: businessA.id },
    select: { assignedMembershipId: true, status: true },
  });
  check(
    "Deactivated membership after the initial read refuses the checklist tap",
    deactivate.ok === false &&
      deactivate.status === 404 &&
      deactivate.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Deactivated checklist tap leaves no checklist write",
    JSON.parse(deactivateVisit.checklistJson).every((item) => item.checked === false) &&
      deactivateJobAfter?.assignedMembershipId === deactivateMem.id &&
      deactivateJobAfter?.status === "IN_PROGRESS",
  );

  const leftoverB = await prisma.jobCrewVisit.findMany({ where: { businessId: businessB.id } });
  const leftoverA = await prisma.jobCrewVisit.findMany({ where: { businessId: businessA.id } });
  check(
    "Checklist records stay isolated by businessId",
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
} catch (error) {
  failures += 1;
  console.error("FAIL - live native checklist progress", error);
} finally {
  await prisma.$disconnect();
}

console.log(
  failures === 0
    ? "\nNative field checklist check passed: OWNER/MEMBER auth, isolation, duplicates, and races held."
    : `\n${failures} native field checklist check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
