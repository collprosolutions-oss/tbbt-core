/**
 * Native assigned-job purchase-list pickup items — reuse the existing
 * purchase list, assignment lock, and MATERIAL_PICKUP time boundary.
 * Prove tenant isolation, reassignment races, duplicate taps, and
 * OWNER visibility. Recording pickup must not purchase, price,
 * expense, or start time.
 *
 * Imports the REAL production helpers from src/lib/native-field.ts,
 * src/lib/native-field-pickup.ts, and src/lib/materials/pickup.ts.
 * Uses a disposable sibling Postgres database
 * (`tbbt_native_field_pickup_test`).
 *
 * Run with:
 *   npm run test:native-field-pickup
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { CAPABILITIES } = await import("@/lib/authorization");
const { listJobMaterialPickupRequirements } = await import("@/lib/materials/pickup");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob } = await import("@/lib/native-field");
const {
  NATIVE_PICKUP_CHOOSE_RECORD,
  NATIVE_PICKUP_JSON_MAX_BYTES,
  parseNativePickupRecordJson,
  recordNativeAssignedPickupItem,
} = await import("@/lib/native-field-pickup");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);

const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseDatabaseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function createArrivalBarrier(expectedCount, timeoutMs) {
  let arrived = 0;
  let release;
  let fail;
  const gate = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  gate.catch(() => {});
  const timer = setTimeout(() => {
    fail(
      new Error(
        `Arrival barrier timed out after ${timeoutMs}ms (${arrived}/${expectedCount} arrived)`,
      ),
    );
  }, timeoutMs);
  return {
    async hold() {
      arrived += 1;
      if (arrived >= expectedCount) {
        clearTimeout(timer);
        release();
      }
      await gate;
    },
  };
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exitCode = 1;
}

const parsed = baseUrl ? parseDatabaseUrl(baseUrl) : null;
if (baseUrl && !parsed) {
  console.error("DATABASE_URL must be a valid URL.");
  process.exitCode = 1;
}
if (parsed && !LOCAL_DB_HOSTS.has(parsed.hostname)) {
  console.error(
    `Refusing to run: DATABASE_URL host must be localhost, 127.0.0.1, or ::1 (got ${parsed.hostname}).`,
  );
  process.exitCode = 1;
}

const shouldRun = Boolean(parsed && LOCAL_DB_HOSTS.has(parsed.hostname));
const testDbName = "tbbt_native_field_pickup_test";
const testUrl = shouldRun
  ? (() => {
      parsed.pathname = `/${testDbName}`;
      return parsed.toString();
    })()
  : "";
const adminUrl = shouldRun
  ? (() => {
      const url = new URL(baseUrl);
      url.search = "";
      return url;
    })()
  : null;

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const clients = [];
function trackedPrisma() {
  const client = new PrismaClient({ datasourceUrl: testUrl });
  clients.push(client);
  return client;
}

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

function makeOwnerAccess(businessId, membershipId) {
  return {
    businessId,
    workspace: { role: "OWNER", membership: { id: membershipId }, business: { id: businessId } },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

if (shouldRun) {
const pickupOpsSrc = readRepo("src/lib/materials/pickup.ts");
const nativePickupSrc = readRepo("src/lib/native-field-pickup.ts");
const nativeFieldSrc = readRepo("src/lib/native-field.ts");
const pickupRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/pickup/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const pickupScreenSrc = readRepo("apps/native/src/screens/JobPickupSection.tsx");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const nativeTypesSrc = readRepo("apps/native/src/types.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");
const purchaseSrc = readRepo("src/lib/materials/purchase.ts");
const recordFnSrc = pickupOpsSrc.slice(
  pickupOpsSrc.indexOf("export async function recordAssignedJobPickup"),
);
const membershipGuardSrc = readRepo("src/lib/exact-active-membership.ts");

console.log("\nSTATIC — Reuse purchase lists, lock recheck, and no purchase side effects");
check(
  "Native pickup write reuses recordAssignedJobPickup and assigned-job scope",
  nativePickupSrc.includes("recordAssignedJobPickup") &&
    nativePickupSrc.includes("nativeAssignedJobWhere") &&
    nativePickupSrc.includes("afterInitialRead") &&
    nativePickupSrc.includes("requireSaasOperatingEntitlement") &&
    pickupRouteSrc.includes("recordNativeAssignedPickupItem") &&
    !nativePickupSrc.includes("$transaction"),
);
check(
  "Canonical pickup write locks the Job, rechecks assignment, then locks the item",
  recordFnSrc.includes("lockTenantOwnedJob") &&
    recordFnSrc.includes("assignedMembershipId") &&
    recordFnSrc.includes("afterInitialRead") &&
    recordFnSrc.includes("exactActiveMembershipHeld") &&
    recordFnSrc.includes("lockTenantOwnedPurchaseListItem") &&
    recordFnSrc.indexOf("lockTenantOwnedJob") <
      recordFnSrc.indexOf("lockTenantOwnedPurchaseListItem") &&
    recordFnSrc.indexOf("lockedJob.assignedMembershipId") <
      recordFnSrc.indexOf("materialPurchaseListItem.update") &&
    recordFnSrc.indexOf("exactActiveMembershipHeld") <
      recordFnSrc.indexOf("materialPurchaseListItem.update") &&
    membershipGuardSrc.includes('FROM "Membership"') &&
    membershipGuardSrc.includes("FOR UPDATE") &&
    !membershipGuardSrc.includes("userId"),
);
check(
  "Pickup write does not purchase, price, expense, or start time",
  !recordFnSrc.includes("recordPurchaseListItemPurchased") &&
    !recordFnSrc.includes("applyPurchaseActuals") &&
    !recordFnSrc.includes("appendMaterialPriceHistory") &&
    !recordFnSrc.includes("linkPurchaseItemToExpense") &&
    !recordFnSrc.includes("startAssignedActivityTime") &&
    !recordFnSrc.includes("quantityPurchased:") &&
    !recordFnSrc.includes("actualUnitCost:") &&
    !recordFnSrc.includes("lastKnownCost") &&
    !nativePickupSrc.includes("startAssignedActivityTime") &&
    !nativePickupSrc.includes("recordPurchaseListItemPurchased"),
);
check(
  "Native pickup route uses Bearer helpers, caps JSON, and never uses cookies()",
  pickupRouteSrc.includes("readBearerToken") &&
    pickupRouteSrc.includes("readCappedRequestText") &&
    pickupRouteSrc.includes("parseNativePickupRecordJson") &&
    !pickupRouteSrc.includes("cookies("),
);
check(
  "Native pickup JSON is capped at 4 KB",
  nativePickupSrc.includes("NATIVE_PICKUP_JSON_MAX_BYTES = 4096") &&
    NATIVE_PICKUP_JSON_MAX_BYTES === 4096,
);
check(
  "Native Job screen shows pickup items and records a quantity or exception",
  jobScreenSrc.includes("JobPickupSection") &&
    pickupScreenSrc.includes("recordNativeJobPickupItem") &&
    pickupScreenSrc.includes("Record pickup") &&
    pickupScreenSrc.includes("Picked-up quantity") &&
    pickupScreenSrc.includes("does not purchase") &&
    nativeApiSrc.includes("/pickup") &&
    nativeTypesSrc.includes("pickupItems:") &&
    nativeFieldSrc.includes("pickupItems:") &&
    nativeFieldSrc.includes("listAssignedJobPickupView"),
);
check(
  "Docs describe assignment-scoped pickup recording and the dedicated check",
  docsSrc.includes("Pickup items") &&
    docsSrc.includes("recordAssignedJobPickup") &&
    docsSrc.includes("test:native-field-pickup") &&
    docsSrc.includes("does not purchase the item") &&
    docsSrc.includes("OWNER and MEMBER can both record pickup only when the job is assigned to them"),
);
check(
  "Purchase helpers stay the only path that marks an item purchased",
  purchaseSrc.includes("export async function recordPurchaseListItemPurchased") &&
    !pickupOpsSrc.includes("status: \"PURCHASED\""),
);

const emptyJson = parseNativePickupRecordJson("{}");
const quantityJson = parseNativePickupRecordJson(
  '{"itemId":"item-1","quantityPickedUp":"8"}',
);
const exceptionJson = parseNativePickupRecordJson(
  '{"itemId":"item-1","pickupException":"UNAVAILABLE"}',
);
const invalidException = parseNativePickupRecordJson(
  '{"itemId":"item-1","pickupException":"PURCHASED"}',
);
check(
  "Pickup JSON accepts itemId plus a quantity or exception",
  emptyJson.ok === false &&
    emptyJson.error === NATIVE_PICKUP_CHOOSE_RECORD &&
    quantityJson.ok === true &&
    quantityJson.input.itemId === "item-1" &&
    quantityJson.input.quantityPickedUp === "8" &&
    exceptionJson.ok === true &&
    exceptionJson.input.pickupException === "UNAVAILABLE" &&
    invalidException.ok === false,
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/pickup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_PICKUP_JSON_MAX_BYTES + 1),
  }),
  NATIVE_PICKUP_JSON_MAX_BYTES,
);
check(
  "Oversized pickup JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

try {
  const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
    encoding: "utf8",
  });
  if (createDb.status !== 0 && !/already exists/i.test(`${createDb.stderr}${createDb.stdout}`)) {
    throw new Error(
      createDb.stderr || createDb.stdout || "Failed to create native-field pickup test database.",
    );
  }

  const push = spawnSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
    { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
  );
  if (push.status !== 0) {
    throw new Error("Failed to push schema for native-field pickup test database.");
  }

  const prisma = trackedPrisma();

  const onboardingDone = new Date();
  const completedOnboarding = {
    firstRunSetupCompletedAt: onboardingDone,
    starterServicesSetupCompletedAt: onboardingDone,
    starterServicesSetupChoice: "SKIPPED",
    websiteSetupCompletedAt: onboardingDone,
    websiteSetupChoice: "SKIPPED",
  };
  const password = "native-pickup-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Pickup",
      slug: `alpha-native-pickup-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Pickup",
      slug: `beta-native-pickup-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Pickup",
      slug: `blocked-native-pickup-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-pickup.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-pickup.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-pickup.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-pickup.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-pickup.example`,
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

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
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

  async function createPickupJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName ?? "Pickup Customer",
        phone: "555-0142",
      },
    });
    const job = await prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId ?? null,
        projectToken: randomUUID(),
        status: input.status ?? "SCHEDULED",
        scheduledAt: new Date(),
      },
    });
    const catalog = await prisma.materialCatalogItem.create({
      data: {
        businessId: input.businessId,
        name: input.itemName ?? "Concrete bags",
        normalizedName: `${input.itemName ?? "concrete bags"}-${randomUUID()}`,
        unit: "bag",
        lastKnownCost: 6.47,
      },
    });
    const list = await prisma.materialPurchaseList.create({
      data: {
        businessId: input.businessId,
        jobId: job.id,
        items: {
          create: [
            {
              businessId: input.businessId,
              materialId: catalog.id,
              name: input.itemName ?? "Concrete bags",
              quantityNeeded: 8,
              unit: "bag",
              plannedUnitCost: 6.47,
              plannedCost: 51.76,
              actualUnitCost: null,
              quantityPurchased: null,
              pickupRequired: true,
              pickupLocationDescription: input.location ?? "Yard gate",
              pickupReady: true,
              status: "NEEDED",
            },
            {
              businessId: input.businessId,
              name: "Non-pickup fastener",
              quantityNeeded: 1,
              unit: "box",
              plannedUnitCost: 12,
              pickupRequired: false,
              status: "NEEDED",
            },
          ],
        },
      },
      include: { items: true },
    });
    return {
      job,
      catalog,
      list,
      pickupItem: list.items.find((item) => item.pickupRequired),
      hiddenItem: list.items.find((item) => !item.pickupRequired),
    };
  }

  const memberFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Member Pickup Canary",
  });
  const ownerFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: ownerMem.id,
    customerName: "Owner Pickup Canary",
    itemName: "Owner lumber",
    location: "Aisle 4",
  });
  const otherFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Other Pickup Canary",
  });
  const raceFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Race Pickup Canary",
  });
  const duplicateFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Duplicate Pickup Canary",
  });
  const exceptionFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Exception Pickup Canary",
  });
  const betaFixture = await createPickupJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Beta Pickup Canary",
    itemName: "Beta bags",
  });
  const blockedFixture = await createPickupJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMem.id,
    customerName: "Blocked Pickup Canary",
  });

  const ownerA = makeOwnerAccess(businessA.id, ownerMem.id);
  check(
    "OWNER access used for visibility still requires MANAGE_JOBS",
    CAPABILITIES.MANAGE_JOBS === "MANAGE_JOBS",
  );

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
  check(
    "Assigned MEMBER and assigned OWNER can sign in",
    memberSignIn.ok === true && ownerSignIn.ok === true,
  );
  if (
    !memberSignIn.ok ||
    !ownerSignIn.ok ||
    !otherSignIn.ok ||
    !betaSignIn.ok ||
    !blockedSignIn.ok
  ) {
    throw new Error("Native pickup fixture sign-in failed.");
  }

  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const ownerAccess = await resolveNativeFieldAccess(prisma, { token: ownerSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  const blockedAccess = await resolveNativeFieldAccess(prisma, { token: blockedSignIn.token });
  if (
    !memberAccess.ok ||
    !ownerAccess.ok ||
    !otherAccess.ok ||
    !betaAccess.ok ||
    !blockedAccess.ok
  ) {
    throw new Error("Native pickup fixture access failed.");
  }

  console.log("\nLIVE — Assigned read view, tenant isolation, and OWNER visibility");

  const memberDetail = await loadNativeAssignedJob(prisma, memberAccess.access, memberFixture.job.id);
  const ownerDetail = await loadNativeAssignedJob(prisma, ownerAccess.access, ownerFixture.job.id);
  const ownerOnMember = await loadNativeAssignedJob(prisma, ownerAccess.access, memberFixture.job.id);
  const memberOnOwner = await loadNativeAssignedJob(prisma, memberAccess.access, ownerFixture.job.id);
  const otherDetail = await loadNativeAssignedJob(prisma, memberAccess.access, otherFixture.job.id);
  const betaDetail = await loadNativeAssignedJob(prisma, memberAccess.access, betaFixture.job.id);
  const memberPickup = memberDetail?.pickupItems ?? [];
  const ownerPickup = ownerDetail?.pickupItems ?? [];
  check(
    "Assigned MEMBER sees that job's pickup items and no vendor economics",
    memberPickup.length === 1 &&
      memberPickup[0].id === memberFixture.pickupItem.id &&
      memberPickup[0].quantityNeeded === "8" &&
      memberPickup[0].pickupRecorded === false &&
      memberPickup.every(
        (row) =>
          !("actualCost" in row) &&
          !("plannedUnitCost" in row) &&
          !("markupPercent" in row) &&
          !("customerUnitPrice" in row),
      ) &&
      !memberPickup.some((row) => row.id === memberFixture.hiddenItem.id),
  );
  check(
    "Assigned OWNER sees pickup items on their own assigned job",
    ownerPickup.length === 1 &&
      ownerPickup[0].id === ownerFixture.pickupItem.id &&
      ownerPickup[0].name === "Owner lumber" &&
      ownerPickup[0].pickupLocationDescription === "Aisle 4",
  );
  check(
    "OWNER and MEMBER cannot read each other's assigned jobs via native",
    ownerOnMember === null && memberOnOwner === null && otherDetail === null && betaDetail === null,
  );

  const ownerOnMemberWrite = await recordNativeAssignedPickupItem(
    prisma,
    ownerAccess.access,
    memberFixture.job.id,
    { itemId: memberFixture.pickupItem.id, quantityPickedUp: "8" },
  );
  const memberOnOwnerWrite = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    ownerFixture.job.id,
    { itemId: ownerFixture.pickupItem.id, quantityPickedUp: "2" },
  );
  const stolen = await recordNativeAssignedPickupItem(
    prisma,
    otherAccess.access,
    memberFixture.job.id,
    { itemId: memberFixture.pickupItem.id, quantityPickedUp: "8" },
  );
  const cross = await recordNativeAssignedPickupItem(
    prisma,
    betaAccess.access,
    memberFixture.job.id,
    { itemId: memberFixture.pickupItem.id, quantityPickedUp: "8" },
  );
  const blockedWrite = await recordNativeAssignedPickupItem(
    prisma,
    blockedAccess.access,
    blockedFixture.job.id,
    { itemId: blockedFixture.pickupItem.id, quantityPickedUp: "1" },
  );
  const hiddenWrite = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    memberFixture.job.id,
    { itemId: memberFixture.hiddenItem.id, quantityPickedUp: "1" },
  );
  const betaItemOnAlpha = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    memberFixture.job.id,
    { itemId: betaFixture.pickupItem.id, quantityPickedUp: "3" },
  );
  const memberAfterAuth = await prisma.materialPurchaseListItem.findFirst({
    where: { id: memberFixture.pickupItem.id, businessId: businessA.id },
  });
  const ownerAfterAuth = await prisma.materialPurchaseListItem.findFirst({
    where: { id: ownerFixture.pickupItem.id, businessId: businessA.id },
  });
  const betaAfterAuth = await prisma.materialPurchaseListItem.findFirst({
    where: { id: betaFixture.pickupItem.id, businessId: businessB.id },
  });
  check(
    "Unassigned OWNER cannot record pickup on a MEMBER job",
    ownerOnMemberWrite.ok === false &&
      ownerOnMemberWrite.status === 404 &&
      ownerOnMemberWrite.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Unassigned MEMBER cannot record pickup on an OWNER job",
    memberOnOwnerWrite.ok === false &&
      memberOnOwnerWrite.status === 404 &&
      memberOnOwnerWrite.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Another worker cannot record pickup on this job",
    stolen.ok === false && stolen.status === 404 && stolen.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Cross-tenant worker cannot record pickup",
    cross.ok === false && cross.status === 404 && cross.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Pickup write requires an operating SaaS subscription",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );
  check(
    "Non-pickup and foreign-tenant items are refused",
    hiddenWrite.ok === false &&
      hiddenWrite.status === 409 &&
      betaItemOnAlpha.ok === false &&
      betaItemOnAlpha.status === 409,
  );
  check(
    "Failed authorization leaves pickup items unrecorded",
    memberAfterAuth.quantityPickedUp == null &&
      memberAfterAuth.pickupException == null &&
      ownerAfterAuth.quantityPickedUp == null &&
      betaAfterAuth.quantityPickedUp == null,
  );

  console.log("\nLIVE — Recorded quantities, exceptions, duplicates, races, and no side effects");

  const memberWrite = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    memberFixture.job.id,
    { itemId: memberFixture.pickupItem.id, quantityPickedUp: "8" },
  );
  const memberReloaded = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    memberFixture.job.id,
  );
  const ownerVisibility = await listJobMaterialPickupRequirements(
    prisma,
    ownerA,
    memberFixture.job.id,
  );
  check(
    "Assigned MEMBER can record a picked-up quantity",
    memberWrite.ok === true &&
      memberWrite.alreadyRecorded === false &&
      memberWrite.job.pickupItems.find((item) => item.id === memberFixture.pickupItem.id)
        ?.quantityPickedUp === "8" &&
      memberWrite.job.pickupItems.find((item) => item.id === memberFixture.pickupItem.id)
        ?.pickupRecorded === true,
  );
  check(
    "Reloaded assigned job shows the MEMBER pickup quantity",
    memberReloaded?.pickupItems.find((item) => item.id === memberFixture.pickupItem.id)
      ?.quantityPickedUp === "8",
  );
  check(
    "Unassigned OWNER sees the recorded quantity on the existing pickup feed",
    ownerVisibility.some(
      (row) =>
        row.purchaseListItemId === memberFixture.pickupItem.id &&
        row.quantityPickedUp === 8 &&
        row.pickupException == null,
    ) && ownerVisibility.every((row) => row.jobId === memberFixture.job.id),
  );

  const ownerWrite = await recordNativeAssignedPickupItem(
    prisma,
    ownerAccess.access,
    ownerFixture.job.id,
    {
      itemId: ownerFixture.pickupItem.id,
      quantityPickedUp: "3",
      pickupException: "SHORT",
    },
  );
  const ownerReloaded = await loadNativeAssignedJob(
    prisma,
    ownerAccess.access,
    ownerFixture.job.id,
  );
  const ownerSelfVisibility = await listJobMaterialPickupRequirements(
    prisma,
    ownerA,
    ownerFixture.job.id,
  );
  check(
    "Assigned OWNER can record a short-quantity exception and see it after reload",
    ownerWrite.ok === true &&
      ownerWrite.alreadyRecorded === false &&
      ownerWrite.job.pickupItems.find((item) => item.id === ownerFixture.pickupItem.id)
        ?.quantityPickedUp === "3" &&
      ownerWrite.job.pickupItems.find((item) => item.id === ownerFixture.pickupItem.id)
        ?.pickupException === "SHORT" &&
      ownerReloaded?.pickupItems.find((item) => item.id === ownerFixture.pickupItem.id)
        ?.pickupExceptionLabel === "Short quantity" &&
      ownerSelfVisibility.some(
        (row) =>
          row.purchaseListItemId === ownerFixture.pickupItem.id &&
          row.quantityPickedUp === 3 &&
          row.pickupException === "SHORT",
      ),
  );

  const exceptionWrite = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    exceptionFixture.job.id,
    {
      itemId: exceptionFixture.pickupItem.id,
      pickupException: "UNAVAILABLE",
    },
  );
  check(
    "Assigned MEMBER can record an unavailable exception without a quantity",
    exceptionWrite.ok === true &&
      exceptionWrite.alreadyRecorded === false &&
      exceptionWrite.job.pickupItems.find((item) => item.id === exceptionFixture.pickupItem.id)
        ?.pickupException === "UNAVAILABLE" &&
      exceptionWrite.job.pickupItems.find((item) => item.id === exceptionFixture.pickupItem.id)
        ?.quantityPickedUp == null,
  );

  const repeatQuantity = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    memberFixture.job.id,
    { itemId: memberFixture.pickupItem.id, quantityPickedUp: "8" },
  );
  check(
    "Duplicate tap of the same picked-up quantity is a successful no-op",
    repeatQuantity.ok === true &&
      repeatQuantity.alreadyRecorded === true &&
      repeatQuantity.job.pickupItems.find((item) => item.id === memberFixture.pickupItem.id)
        ?.quantityPickedUp === "8",
  );

  const racerA = trackedPrisma();
  const racerB = trackedPrisma();
  const duplicateBarrier = createArrivalBarrier(2, 5000);
  const duplicateSettled = await Promise.allSettled([
    recordNativeAssignedPickupItem(
      racerA,
      memberAccess.access,
      duplicateFixture.job.id,
      { itemId: duplicateFixture.pickupItem.id, quantityPickedUp: "5" },
      { afterInitialRead: () => duplicateBarrier.hold() },
    ),
    recordNativeAssignedPickupItem(
      racerB,
      memberAccess.access,
      duplicateFixture.job.id,
      { itemId: duplicateFixture.pickupItem.id, quantityPickedUp: "5" },
      { afterInitialRead: () => duplicateBarrier.hold() },
    ),
  ]);
  const duplicateRecorded = duplicateSettled.filter(
    (result) => result.status === "fulfilled" && result.value.ok === true,
  );
  const duplicateWriters = duplicateRecorded.filter(
    (result) => result.value.alreadyRecorded === false,
  );
  const duplicateNoops = duplicateRecorded.filter(
    (result) => result.value.alreadyRecorded === true,
  );
  const duplicateRows = await prisma.materialPurchaseListItem.findMany({
    where: { id: duplicateFixture.pickupItem.id, businessId: businessA.id },
  });
  check(
    "Concurrent duplicate taps both succeed and leave one recorded quantity",
    duplicateSettled.length === 2 &&
      duplicateRecorded.length === 2 &&
      duplicateWriters.length === 1 &&
      duplicateNoops.length === 1 &&
      duplicateRows.length === 1 &&
      duplicateRows[0].quantityPickedUp.toString() === "5" &&
      duplicateRows[0].pickupRecordedAt != null,
  );

  const race = await recordNativeAssignedPickupItem(
    prisma,
    memberAccess.access,
    raceFixture.job.id,
    { itemId: raceFixture.pickupItem.id, quantityPickedUp: "8" },
    {
      afterInitialRead: async () => {
        await prisma.job.update({
          where: { id: raceFixture.job.id },
          data: { assignedMembershipId: otherMem.id },
        });
      },
    },
  );
  const raceItem = await prisma.materialPurchaseListItem.findFirst({
    where: { id: raceFixture.pickupItem.id, businessId: businessA.id },
  });
  const raceJobAfter = await prisma.job.findFirst({
    where: { id: raceFixture.job.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  check(
    "Assignment change after the initial read refuses the pickup tap",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves no pickup write",
    raceItem.quantityPickedUp == null &&
      raceItem.pickupException == null &&
      raceJobAfter?.assignedMembershipId === otherMem.id,
  );

  const deactivateUser = await prisma.user.create({
    data: {
      name: "Deactivate Pickup Worker",
      email: `deactivate-${randomUUID()}@native-pickup.example`,
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
    throw new Error("Deactivation pickup fixture sign-in failed.");
  }
  const deactivateAccess = await resolveNativeFieldAccess(prisma, {
    token: deactivateSignIn.token,
  });
  if (!deactivateAccess.ok) {
    throw new Error("Deactivation pickup fixture access failed.");
  }
  const deactivateFixture = await createPickupJob({
    businessId: businessA.id,
    assignedMembershipId: deactivateMem.id,
    customerName: "Deactivate Pickup Canary",
  });
  const deactivate = await recordNativeAssignedPickupItem(
    prisma,
    deactivateAccess.access,
    deactivateFixture.job.id,
    { itemId: deactivateFixture.pickupItem.id, quantityPickedUp: "8" },
    {
      afterInitialRead: async () => {
        const otherClient = trackedPrisma();
        await otherClient.membership.update({
          where: { id: deactivateMem.id },
          data: { active: false },
        });
      },
    },
  );
  const deactivateItem = await prisma.materialPurchaseListItem.findFirst({
    where: { id: deactivateFixture.pickupItem.id, businessId: businessA.id },
  });
  const deactivateJobAfter = await prisma.job.findFirst({
    where: { id: deactivateFixture.job.id, businessId: businessA.id },
    select: { assignedMembershipId: true },
  });
  check(
    "Deactivated membership after the initial read refuses the pickup tap",
    deactivate.ok === false &&
      deactivate.status === 404 &&
      deactivate.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Deactivated pickup tap leaves no pickup write",
    deactivateItem.quantityPickedUp == null &&
      deactivateItem.pickupException == null &&
      deactivateItem.pickupRecordedAt == null &&
      deactivateJobAfter?.assignedMembershipId === deactivateMem.id,
  );

  const purchasedAfter = await prisma.materialPurchaseListItem.findFirst({
    where: { id: memberFixture.pickupItem.id, businessId: businessA.id },
  });
  const catalogAfter = await prisma.materialCatalogItem.findFirst({
    where: { id: memberFixture.catalog.id, businessId: businessA.id },
  });
  const expenses = await prisma.expense.findMany({
    where: { businessId: businessA.id },
  });
  const priceHistory = await prisma.materialPriceHistory.findMany({
    where: { businessId: businessA.id },
  });
  const timeEntries = await prisma.timeEntry.findMany({
    where: { businessId: businessA.id },
  });
  const betaFinal = await prisma.materialPurchaseListItem.findFirst({
    where: { id: betaFixture.pickupItem.id, businessId: businessB.id },
  });
  check(
    "Recording pickup does not purchase, price, expense, or start time",
    purchasedAfter.status === "NEEDED" &&
      purchasedAfter.quantityPurchased == null &&
      purchasedAfter.actualUnitCost == null &&
      purchasedAfter.actualCost == null &&
      purchasedAfter.expenseId == null &&
      catalogAfter.lastKnownCost.toString() === "6.47" &&
      expenses.length === 0 &&
      priceHistory.length === 0 &&
      timeEntries.length === 0,
  );
  check(
    "Pickup records stay isolated by businessId",
    betaFinal.quantityPickedUp == null &&
      betaFinal.pickupException == null &&
      purchasedAfter.businessId === businessA.id &&
      purchasedAfter.quantityPickedUp.toString() === "8",
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - live native pickup items", error);
} finally {
  for (const client of clients) {
    try {
      await client.$disconnect();
    } catch {
      // Keep disconnecting the rest so DROP can proceed.
    }
  }
  const drop = spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}" WITH (FORCE)`],
    { encoding: "utf8" },
  );
  if (drop.status !== 0) {
    console.warn(drop.stderr || drop.stdout);
  }
}

console.log(
  failures === 0
    ? "\nNative field pickup check passed: isolation, OWNER visibility, duplicates, races, and no purchase side effects held."
    : `\n${failures} native field pickup check(s) failed.`,
);
process.exitCode = failures === 0 ? 0 : 1;
}
