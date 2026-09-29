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
const {
  attachCleaningCrewChecklist,
  recordAssignedVisitOutcome,
  setCleaningVisitCadence,
} = await import("@/lib/cleaning-visit-ops");
const {
  packCrewChecklist,
  serializeChecklist,
  toggleChecklistItem,
} = await import("@/lib/cleaning-visit-workflow");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob } = await import("@/lib/native-field");
const {
  NATIVE_CHECKLIST_CHOOSE_ITEM,
  NATIVE_CHECKLIST_CLOSED_MESSAGE,
  NATIVE_CHECKLIST_MAX_CHANGED_ITEMS,
  NATIVE_CHECKLIST_NO_ITEMS_MESSAGE,
  NATIVE_CHECKLIST_STALE_MESSAGE,
  NATIVE_CHECKLIST_SYNC_JSON_MAX_BYTES,
  checklistStateFingerprint,
  parseNativeChecklistSyncJson,
  syncNativeAssignedChecklistDraft,
} = await import("@/lib/native-field-checklist");
const { createOperatingProcedure, setOperatingProcedureApproval } = await import(
  "@/lib/operating-procedures-ops"
);
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const { completeJobWithRunningTimeSafety } = await import("@/lib/time-card-ops");
const {
  CHECKLIST_DRAFT_INDEX_KEY,
  CHECKLIST_DRAFT_INDEX_MAX_KEYS,
  CHECKLIST_DRAFT_SYNC_BEFORE_MORE_CHANGES,
  CHECKLIST_DRAFT_INDEX_FULL_MESSAGE,
  SECURE_STORE_KEY_PATTERN,
  SECURE_STORE_VALUE_MAX_BYTES,
  applyChecklistDraftAccount,
  checklistDraftStorageKey,
  checklistStateFingerprint: nativeDraftFingerprint,
  clearAllChecklistDrafts,
  createMemoryChecklistDraftStorage,
  isSecureStoreKey,
  loadChecklistDraft,
  overlayChecklistDraft,
  persistLocalChecklistChange,
  recordLocalChecklistChange,
  storedByteLength,
} = await import(new URL("../apps/native/src/checklist-drafts.ts", import.meta.url));

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

function assertLocalTestDatabase(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(
      "Refuse to CREATE DATABASE or prisma db push --accept-data-loss unless DATABASE_URL is localhost or 127.0.0.1.",
    );
    process.exit(1);
  }
}

assertLocalTestDatabase(baseUrl);

const testDbName = "tbbt_native_field_checklist_offline_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const adminUrl = new URL(baseUrl);
adminUrl.search = "";

function dropTestDatabase() {
  return spawnSync(
    "psql",
    [adminUrl.toString(), "-c", `DROP DATABASE IF EXISTS "${testDbName}"`],
    { encoding: "utf8" },
  );
}

const dropped = dropTestDatabase();
if (dropped.status !== 0) {
  console.warn(dropped.stderr || dropped.stdout);
}

const createDb = spawnSync("psql", [adminUrl.toString(), "-c", `CREATE DATABASE "${testDbName}"`], {
  encoding: "utf8",
});
if (createDb.status !== 0) {
  console.error(createDb.stderr || createDb.stdout);
  process.exit(createDb.status ?? 1);
}

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);
if (push.status !== 0) {
  console.error("Failed to push schema for native-field checklist offline test database.");
  dropTestDatabase();
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
const visitOpsSrc = readRepo("src/lib/cleaning-visit-ops.ts");
const timeCardSrc = readRepo("src/lib/time-card-ops.ts");
const offlineCheckSrc = readRepo("scripts/check-native-field-checklist-offline.mjs");
const appSrc = readRepo("apps/native/App.tsx");
const signInSrc = readRepo("apps/native/src/screens/SignInScreen.tsx");
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
    checklistOpsSrc.includes("jobCrewVisit.updateMany") &&
    checklistOpsSrc.includes("updated.count !== 1") &&
    checklistOpsSrc.includes("toggleChecklistItem") &&
    checklistOpsSrc.includes("NATIVE_CHECKLIST_CLOSED_MESSAGE") &&
    checklistOpsSrc.includes("alreadySynced") &&
    !checklistOpsSrc.includes("const alreadySynced =") &&
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
    checklistSectionSrc.includes("Saved on this phone") &&
    !checklistSectionSrc.includes("Saving…") &&
    checklistSectionSrc.includes("persistLocalChecklistChange") &&
    checklistSectionSrc.includes("syncNativeJobChecklistDraft") &&
    checklistSectionSrc.includes("try {") &&
    checklistSectionSrc.includes("finally") &&
    checklistSectionSrc.includes("NATIVE_CHECKLIST_OFFLINE_MESSAGE") &&
    checklistSectionSrc.includes("changed after your draft") &&
    checklistSectionSrc.includes("loadNativeJob") &&
    jobScreenSrc.includes("Sync or discard unsynced checklist changes before completing this job.") &&
    jobScreenSrc.includes("Sync or discard unsynced checklist changes before recording a visit outcome.") &&
    !checklistSectionSrc.includes("completeNativeJob") &&
    !checklistSectionSrc.includes("startNativeJob") &&
    !checklistSectionSrc.includes("startNativeActivityTime") &&
    !checklistSectionSrc.includes("recordNativeJobVisit") &&
    !checklistSectionSrc
      .slice(
        checklistSectionSrc.indexOf("useEffect(()"),
        checklistSectionSrc.indexOf("if (!source)"),
      )
      .includes("syncNativeJobChecklistDraft") &&
    jobScreenSrc.includes("JobChecklistSection") &&
    !jobScreenSrc.includes("recordNativeJobChecklistItem") &&
    nativeApiSrc.includes("/checklist/sync") &&
    nativeApiSrc.includes("NATIVE_CHECKLIST_OFFLINE_MESSAGE") &&
    draftSrc.includes("createMemoryChecklistDraftStorage") &&
    draftSrc.includes("SECURE_STORE_KEY_PATTERN") &&
    draftSrc.includes("clearAllChecklistDrafts") &&
    draftSrc.includes("CHECKLIST_DRAFT_SYNC_BEFORE_MORE_CHANGES") &&
    draftSrc.includes("rememberDraftKey(storage, key)") &&
    draftSrc.indexOf("await rememberDraftKey(storage, key)") <
      draftSrc.indexOf("await storage.write(key, payload)") &&
    NATIVE_CHECKLIST_MAX_CHANGED_ITEMS >= 30 &&
    !checklistOpsSrc.includes("NATIVE_CHECKLIST_MAX_ITEMS = 12") &&
    checklistOpsSrc.includes("expectedFingerprint") &&
    checklistOpsSrc.includes("baseChecked") &&
    checklistOpsSrc.includes("checklistStateFingerprint"),
);
check(
  "Docs describe explicit sync, stale refusal, and the dedicated check",
  docsSrc.includes("Unsynced") &&
    docsSrc.includes("Sync checklist") &&
    docsSrc.includes("refuses a stale or reassigned draft") &&
    docsSrc.includes("does not background-write") &&
    docsSrc.includes("Every native checklist tap is local") &&
    docsSrc.includes("test:native-field-checklist-offline"),
);
check(
  "Test database is dropped before create and after a failed db push",
  offlineCheckSrc.includes('DROP DATABASE IF EXISTS "${testDbName}"') &&
    offlineCheckSrc.indexOf("dropTestDatabase()") <
      offlineCheckSrc.indexOf('CREATE DATABASE "${testDbName}"') &&
    offlineCheckSrc.includes("dropTestDatabase();") &&
    /if \(push\.status !== 0\) \{[\s\S]*dropTestDatabase\(\);[\s\S]*process\.exit/.test(
      offlineCheckSrc,
    ),
);
check(
  "OWNER attach and cadence writes lock the Job before replacing checklistJson",
  visitOpsSrc.includes("export async function attachCleaningCrewChecklist") &&
    visitOpsSrc.indexOf("lockTenantOwnedJob") <
      visitOpsSrc.indexOf("return upsertVisitRecord") &&
    visitOpsSrc.includes('await db.$transaction(async (tx) => {') &&
    visitOpsSrc.includes("if (input.afterInitialRead)") &&
    timeCardSrc.includes("completeJobWithRunningTimeSafety") &&
    timeCardSrc.includes("afterInitialRead") &&
    appSrc.includes("clearAllChecklistDrafts") &&
    appSrc.includes("restored.status === 401") &&
    appSrc.includes("restored.status === 403") &&
    signInSrc.includes("applyChecklistDraftAccount") &&
    !signInSrc.includes("clearAllChecklistDrafts(") &&
    checklistSectionSrc.includes("itemUnsynced") &&
    checklistSectionSrc.indexOf('? "Saved on this phone"') >
      checklistSectionSrc.indexOf("itemUnsynced"),
);

function expectedFromItems(items) {
  return items.map((item) => ({ key: item.key, checked: item.checked }));
}

function syncPayload(expectedItems, items) {
  return {
    expectedFingerprint: checklistStateFingerprint(expectedFromItems(expectedItems)),
    items,
  };
}

const emptySync = parseNativeChecklistSyncJson("{}");
const kitchenExpected = packCrewChecklist().map((item) => ({
  key: item.key,
  checked: item.checked,
}));
const kitchenFingerprint = checklistStateFingerprint(kitchenExpected);
const validSync = parseNativeChecklistSyncJson(
  JSON.stringify({
    expectedFingerprint: kitchenFingerprint,
    items: [{ itemKey: "kitchen", checked: true, baseChecked: false }],
  }),
);
check(
  "Sync JSON requires a full-state fingerprint plus at least one changed item",
  emptySync.ok === false &&
    emptySync.error === NATIVE_CHECKLIST_CHOOSE_ITEM &&
    validSync.ok === true &&
    validSync.items[0].itemKey === "kitchen" &&
    validSync.items[0].checked === true &&
    validSync.items[0].baseChecked === false &&
    validSync.expectedFingerprint === kitchenFingerprint &&
    nativeDraftFingerprint(kitchenExpected) === kitchenFingerprint,
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
    first.items[0].baseChecked === false &&
    first.expectedFingerprint === checklistStateFingerprint(serverItems),
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

const cuidScope = {
  businessId: "clxyz0123456789abcdefghij",
  membershipId: "mem_field-worker.1",
  jobId: "550e8400-e29b-41d4-a716-446655440000",
};
const generatedKeys = [
  checklistDraftStorageKey(scope),
  checklistDraftStorageKey(otherScope),
  checklistDraftStorageKey(cuidScope),
  CHECKLIST_DRAFT_INDEX_KEY,
];
check(
  "Every generated draft key is a valid expo-secure-store key",
  generatedKeys.every((key) => SECURE_STORE_KEY_PATTERN.test(key) && isSecureStoreKey(key)) &&
    !SECURE_STORE_KEY_PATTERN.test("tbbt.native.checklist.draft:biz-a:mem-a:job-a"),
);

const indexed = createMemoryChecklistDraftStorage();
await persistLocalChecklistChange(indexed, {
  scope,
  serverItems,
  itemKey: "floors",
  checked: true,
});
await persistLocalChecklistChange(indexed, {
  scope: otherScope,
  serverItems,
  itemKey: "trash",
  checked: true,
});
const beforeClear = await Promise.all([
  loadChecklistDraft(indexed, scope),
  loadChecklistDraft(indexed, otherScope),
]);
await clearAllChecklistDrafts(indexed);
const afterClear = await Promise.all([
  loadChecklistDraft(indexed, scope),
  loadChecklistDraft(indexed, otherScope),
]);
check(
  "Sign-out clears every indexed checklist draft",
  beforeClear.every((row) => row !== null) && afterClear.every((row) => row === null),
);

const compact = await persistLocalChecklistChange(createMemoryChecklistDraftStorage(), {
  scope,
  serverItems,
  itemKey: "walkthrough",
  checked: true,
});
check(
  "Persisted drafts store a base fingerprint plus only changed items",
  Boolean(compact?.expectedFingerprint) &&
    compact.items.length === 1 &&
    compact.items[0].itemKey === "walkthrough" &&
    compact.items[0].baseChecked === false &&
    !JSON.stringify(compact).includes("expectedChecked") &&
    !JSON.stringify(compact).includes("expectedChecklist"),
);

const thirtyItems = Array.from({ length: 30 }, (_, index) => ({
  key: `c${String(index + 1).padStart(24, "0")}`,
  title: `Step ${index + 1}`,
  required: true,
  checked: false,
}));
const thirtyScope = {
  businessId: "clthirty0123456789abcdef1",
  membershipId: "clthirty0123456789abcdef2",
  jobId: "clthirty0123456789abcdef3",
};
const thirtyStorage = createMemoryChecklistDraftStorage();
const thirtyDraft = await persistLocalChecklistChange(thirtyStorage, {
  scope: thirtyScope,
  serverItems: thirtyItems,
  itemKey: thirtyItems[0].key,
  checked: true,
});
const thirtyReloaded = await loadChecklistDraft(thirtyStorage, thirtyScope);
const thirtyRaw = await thirtyStorage.read(checklistDraftStorageKey(thirtyScope));
check(
  "A 30-item cuid checklist stores only the tapped change under 2048 bytes",
  thirtyDraft?.items.length === 1 &&
    thirtyDraft.items[0].itemKey === thirtyItems[0].key &&
    thirtyDraft.items[0].checked === true &&
    thirtyDraft.items[0].baseChecked === false &&
    thirtyReloaded?.expectedFingerprint === checklistStateFingerprint(thirtyItems) &&
    storedByteLength(thirtyRaw ?? "") <= SECURE_STORE_VALUE_MAX_BYTES,
);

const overflowItems = Array.from({ length: 40 }, (_, index) => ({
  key: `k${String(index).padStart(80, "x")}`,
  title: `Overflow ${index}`,
  required: true,
  checked: false,
}));
const overflowScope = { ...scope, jobId: "job-overflow" };
const overflowStorage = createMemoryChecklistDraftStorage();
let overflowDraft = await persistLocalChecklistChange(overflowStorage, {
  scope: overflowScope,
  serverItems: overflowItems,
  itemKey: overflowItems[0].key,
  checked: true,
});
let overflowError = null;
for (const item of overflowItems.slice(1)) {
  try {
    overflowDraft = await persistLocalChecklistChange(overflowStorage, {
      scope: overflowScope,
      serverItems: overflowItems,
      itemKey: item.key,
      checked: true,
    });
  } catch (error) {
    overflowError = error;
    break;
  }
}
const overflowKept = await loadChecklistDraft(overflowStorage, overflowScope);
check(
  "A draft that cannot fit more changes says sync before more changes and keeps prior taps",
  overflowError instanceof Error &&
    overflowError.message === CHECKLIST_DRAFT_SYNC_BEFORE_MORE_CHANGES &&
    overflowKept?.items.length === overflowDraft?.items.length &&
    overflowKept?.items.length >= 1,
);

const indexOrder = [];
const indexOrderData = new Map();
const indexFirstStorage = {
  async read(key) {
    return indexOrderData.has(key) ? (indexOrderData.get(key) ?? null) : null;
  },
  async write(key, value) {
    indexOrder.push(key);
    indexOrderData.set(key, value);
  },
  async remove(key) {
    indexOrderData.delete(key);
  },
};
await persistLocalChecklistChange(indexFirstStorage, {
  scope,
  serverItems,
  itemKey: "kitchen",
  checked: true,
});
check(
  "Draft index is written before the draft payload",
  indexOrder[0] === CHECKLIST_DRAFT_INDEX_KEY &&
    indexOrder[1] === checklistDraftStorageKey(scope),
);

const capStorage = createMemoryChecklistDraftStorage();
let capError = null;
for (let index = 0; index < CHECKLIST_DRAFT_INDEX_MAX_KEYS + 1; index += 1) {
  try {
    await persistLocalChecklistChange(capStorage, {
      scope: { ...scope, jobId: `job-cap-${index}` },
      serverItems,
      itemKey: "kitchen",
      checked: true,
    });
  } catch (error) {
    capError = error;
  }
}
const firstCapped = await loadChecklistDraft(capStorage, {
  ...scope,
  jobId: "job-cap-0",
});
check(
  "The draft index stays under 2048 bytes and refuses a 17th job with a clear message",
  capError instanceof Error &&
    capError.message === CHECKLIST_DRAFT_INDEX_FULL_MESSAGE &&
    firstCapped?.items[0].itemKey === "kitchen",
);

const explodingStorage = {
  async read() {
    throw new Error("index read failed");
  },
  async write() {
    throw new Error("index write failed");
  },
  async remove() {
    throw new Error("index remove failed");
  },
};
let clearThrew = false;
try {
  await clearAllChecklistDrafts(explodingStorage);
} catch {
  clearThrew = true;
}
check("clearAllChecklistDrafts never throws", clearThrew === false);

const accountStorage = createMemoryChecklistDraftStorage();
await persistLocalChecklistChange(accountStorage, {
  scope,
  serverItems,
  itemKey: "kitchen",
  checked: true,
});
await applyChecklistDraftAccount(accountStorage, {
  businessId: scope.businessId,
  membershipId: scope.membershipId,
});
const sameAccountDraft = await loadChecklistDraft(accountStorage, scope);
await applyChecklistDraftAccount(accountStorage, {
  businessId: scope.businessId,
  membershipId: scope.membershipId,
});
const stillSameAccountDraft = await loadChecklistDraft(accountStorage, scope);
await applyChecklistDraftAccount(accountStorage, {
  businessId: "biz-other",
  membershipId: "mem-other",
});
const switchedAccountDraft = await loadChecklistDraft(accountStorage, scope);
check(
  "Sign-in keeps drafts for the same business+membership and clears only on account switch",
  sameAccountDraft?.items[0].itemKey === "kitchen" &&
    stillSameAccountDraft?.items[0].itemKey === "kitchen" &&
    switchedAccountDraft === null,
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
  const completedJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
    status: "COMPLETED",
  });
  const canceledJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
    status: "CANCELED",
  });
  const outcomeJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const concurrentJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const thirtyJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
    customerName: "Thirty Step Offline Checklist",
  });
  const outcomeRaceJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const completeRaceJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });
  const attachRaceJob = await createTradeJob({
    businessId: businessA.id,
    tradeCode: "CLEANING",
    assignedMembershipId: memberMem.id,
  });

  const attachProcedure = await createOperatingProcedure(prisma, ownerA, {
    title: "Replacement Crew Checklist",
    tradeCode: "CLEANING",
    steps: [
      { title: "Entry walkthrough" },
      { title: "Supply restock" },
      { title: "Exit photo" },
    ],
  });
  await setOperatingProcedureApproval(prisma, ownerA, {
    procedureId: attachProcedure.id,
    approvalState: "APPROVED",
  });

  for (const job of [
    memberJob,
    ownerJob,
    otherJob,
    raceJob,
    staleJob,
    completedJob,
    canceledJob,
    outcomeJob,
    concurrentJob,
    thirtyJob,
    outcomeRaceJob,
    completeRaceJob,
    attachRaceJob,
  ]) {
    await setCleaningVisitCadence(prisma, ownerA, { jobId: job.id, cadence: "WEEKLY" });
  }
  await prisma.jobCrewVisit.update({
    where: { jobId: thirtyJob.id },
    data: { checklistJson: serializeChecklist(thirtyItems) },
  });
  await prisma.jobCrewVisit.update({
    where: { jobId: outcomeJob.id },
    data: { outcomeStatus: "VISIT_COMPLETED" },
  });
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
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
  );
  const memberOnOwner = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    ownerJob.id,
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
  );
  const stolen = await syncNativeAssignedChecklistDraft(
    prisma,
    otherAccess.access,
    memberJob.id,
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
  );
  const cross = await syncNativeAssignedChecklistDraft(
    prisma,
    betaAccess.access,
    memberJob.id,
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
  );
  const handyBareWrite = await syncNativeAssignedChecklistDraft(
    prisma,
    handyAccess.access,
    handyBareJob.id,
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
  );
  const blockedWrite = await syncNativeAssignedChecklistDraft(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    {
      ...syncPayload(packCrewChecklist(), [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
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
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
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
      ...syncPayload(expectedFrom(ownerDetail), [
        { itemKey: "floors", checked: true, baseChecked: false },
      ]),
    },
  );
  check(
    "Assigned OWNER can sync a floors draft",
    ownerSync.ok === true &&
      ownerSync.job.checklist?.items.find((item) => item.key === "floors")?.checked === true,
  );

  const replay = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    memberJob.id,
    syncPayload(expectedMember, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
  );
  check(
    "Replaying a committed draft succeeds as alreadySynced without rewriting",
    replay.ok === true &&
      replay.alreadySynced === true &&
      replay.job.checklist?.items.find((item) => item.key === "kitchen")?.checked === true,
  );

  const completedExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, completedJob.id),
  );
  const completedSync = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    completedJob.id,
    {
      ...syncPayload(completedExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
    },
  );
  const canceledExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, canceledJob.id),
  );
  const canceledSync = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    canceledJob.id,
    {
      ...syncPayload(canceledExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
    },
  );
  const outcomeExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, outcomeJob.id),
  );
  const outcomeSync = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    outcomeJob.id,
    {
      ...syncPayload(outcomeExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
    },
  );
  const closedAfter = await prisma.jobCrewVisit.findMany({
    where: { jobId: { in: [completedJob.id, canceledJob.id, outcomeJob.id] } },
  });
  check(
    "Completed and canceled jobs refuse late checklist sync",
    completedSync.ok === false &&
      completedSync.status === 409 &&
      completedSync.error === NATIVE_CHECKLIST_CLOSED_MESSAGE &&
      canceledSync.ok === false &&
      canceledSync.status === 409 &&
      canceledSync.error === NATIVE_CHECKLIST_CLOSED_MESSAGE,
  );
  check(
    "A recorded visit outcome refuses late checklist sync",
    outcomeSync.ok === false &&
      outcomeSync.status === 409 &&
      outcomeSync.error === NATIVE_CHECKLIST_CLOSED_MESSAGE &&
      closedAfter.every((row) =>
        JSON.parse(row.checklistJson).every((item) => item.checked === false),
      ),
  );

  const concurrentExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, concurrentJob.id),
  );
  let releaseBarrier;
  let started = 0;
  const barrier = new Promise((resolve) => {
    releaseBarrier = resolve;
  });
  async function waitForPeer() {
    started += 1;
    if (started === 2) releaseBarrier();
    await barrier;
  }
  const [left, right] = await Promise.all([
    syncNativeAssignedChecklistDraft(
      prisma,
      memberAccess.access,
      concurrentJob.id,
      syncPayload(concurrentExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
      { afterInitialRead: waitForPeer },
    ),
    syncNativeAssignedChecklistDraft(
      prisma,
      memberAccess.access,
      concurrentJob.id,
      syncPayload(concurrentExpected, [
        { itemKey: "bathrooms", checked: true, baseChecked: false },
      ]),
      { afterInitialRead: waitForPeer },
    ),
  ]);
  const concurrentVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: concurrentJob.id, businessId: businessA.id },
  });
  const concurrentItems = JSON.parse(concurrentVisit.checklistJson);
  const winners = [left, right].filter((row) => row.ok === true);
  const staleLosers = [left, right].filter(
    (row) => row.ok === false && row.status === 409 && row.error === NATIVE_CHECKLIST_STALE_MESSAGE,
  );
  const winnerChecked =
    left.ok && left.alreadySynced === false
      ? "kitchen"
      : right.ok && right.alreadySynced === false
        ? "bathrooms"
        : null;
  check(
    "Two concurrent syncs on the same base leave exactly one winner and one stale 409",
    winners.length === 1 &&
      staleLosers.length === 1 &&
      winnerChecked !== null &&
      concurrentItems.find((item) => item.key === winnerChecked)?.checked === true &&
      concurrentItems.filter((item) => item.checked === true).length === 1,
  );

  const handySync = await syncNativeAssignedChecklistDraft(
    prisma,
    handyAccess.access,
    handyListedJob.id,
    syncPayload(expectedFrom(handyListedDetail), [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
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
    syncPayload(staleExpected, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
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
    syncPayload(raceExpected, [
      { itemKey: "kitchen", checked: true, baseChecked: false },
    ]),
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

  const thirtyLiveScope = {
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: thirtyJob.id,
  };
  const thirtyLiveDraft = await persistLocalChecklistChange(
    createMemoryChecklistDraftStorage(),
    {
      scope: thirtyLiveScope,
      serverItems: thirtyItems,
      itemKey: thirtyItems[0].key,
      checked: true,
    },
  );
  const thirtySync = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    thirtyJob.id,
    {
      expectedFingerprint: thirtyLiveDraft.expectedFingerprint,
      items: thirtyLiveDraft.items,
    },
  );
  const thirtyAfterSync = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    thirtyJob.id,
  );
  const thirtyServerItems =
    thirtyAfterSync?.checklist?.items ?? thirtyAfterSync?.visit?.checklist ?? [];
  const thirtyStaleDraft = await persistLocalChecklistChange(
    createMemoryChecklistDraftStorage(),
    {
      scope: thirtyLiveScope,
      serverItems: thirtyServerItems,
      itemKey: thirtyItems[1].key,
      checked: true,
    },
  );
  await prisma.jobCrewVisit.update({
    where: { jobId: thirtyJob.id },
    data: {
      checklistJson: serializeChecklist(
        toggleChecklistItem(thirtyServerItems, thirtyItems[2].key, true),
      ),
    },
  });
  const thirtyStale = await syncNativeAssignedChecklistDraft(
    prisma,
    memberAccess.access,
    thirtyJob.id,
    {
      expectedFingerprint: thirtyStaleDraft.expectedFingerprint,
      items: thirtyStaleDraft.items,
    },
  );
  const thirtyAfterStale = await prisma.jobCrewVisit.findFirst({
    where: { jobId: thirtyJob.id, businessId: businessA.id },
  });
  const thirtyAfterStaleItems = JSON.parse(thirtyAfterStale.checklistJson);
  check(
    "Thirty cuid-keyed items can tap, save a draft, sync, and fail a later stale check",
    thirtyItems.length === 30 &&
      thirtyItems.every((item) => /^c[0-9]{24}$/.test(item.key)) &&
      thirtyLiveDraft?.items.length === 1 &&
      thirtySync.ok === true &&
      thirtySync.alreadySynced === false &&
      thirtyAfterSync?.checklist?.items.find((item) => item.key === thirtyItems[0].key)
        ?.checked === true &&
      thirtyStale.ok === false &&
      thirtyStale.status === 409 &&
      thirtyStale.error === NATIVE_CHECKLIST_STALE_MESSAGE &&
      thirtyAfterStaleItems.find((item) => item.key === thirtyItems[0].key)?.checked === true &&
      thirtyAfterStaleItems.find((item) => item.key === thirtyItems[1].key)?.checked === false &&
      thirtyAfterStaleItems.find((item) => item.key === thirtyItems[2].key)?.checked === true,
  );

  function createTwoPartyBarrier() {
    let releaseBarrier;
    let started = 0;
    const barrier = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    return async function waitForPeer() {
      started += 1;
      if (started === 2) releaseBarrier();
      await barrier;
    };
  }

  const outcomeRaceExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, outcomeRaceJob.id),
  );
  const waitOutcome = createTwoPartyBarrier();
  const [outcomeRaceSync, outcomeRaceWrite] = await Promise.all([
    syncNativeAssignedChecklistDraft(
      prisma,
      memberAccess.access,
      outcomeRaceJob.id,
      syncPayload(outcomeRaceExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
      { afterInitialRead: waitOutcome },
    ),
    recordAssignedVisitOutcome(
      prisma,
      { businessId: businessA.id, membershipId: memberMem.id },
      {
        jobId: outcomeRaceJob.id,
        outcomeStatus: "VISIT_COMPLETED",
        afterInitialRead: waitOutcome,
      },
    )
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error })),
  ]);
  const outcomeRaceVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: outcomeRaceJob.id, businessId: businessA.id },
  });
  const outcomeRaceKitchen = JSON.parse(outcomeRaceVisit.checklistJson).find(
    (item) => item.key === "kitchen",
  )?.checked;
  check(
    "Sync vs recordAssignedVisitOutcome serializes to closed/stale 409 or one write, with no lost write",
    ((outcomeRaceSync.ok === true &&
      outcomeRaceKitchen === true &&
      outcomeRaceWrite.ok === true) ||
      (outcomeRaceSync.ok === false &&
        outcomeRaceSync.status === 409 &&
        (outcomeRaceSync.error === NATIVE_CHECKLIST_CLOSED_MESSAGE ||
          outcomeRaceSync.error === NATIVE_CHECKLIST_STALE_MESSAGE) &&
        outcomeRaceKitchen === false &&
        outcomeRaceWrite.ok === true)) &&
      outcomeRaceVisit.outcomeStatus !== "NONE",
  );

  const completeRaceExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, completeRaceJob.id),
  );
  const waitComplete = createTwoPartyBarrier();
  const [completeRaceSync, completeRaceWrite] = await Promise.all([
    syncNativeAssignedChecklistDraft(
      prisma,
      memberAccess.access,
      completeRaceJob.id,
      syncPayload(completeRaceExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
      { afterInitialRead: waitComplete },
    ),
    completeJobWithRunningTimeSafety(
      prisma,
      {
        businessId: businessA.id,
        jobId: completeRaceJob.id,
        actorMembershipId: memberMem.id,
      },
      { afterInitialRead: waitComplete },
    ),
  ]);
  const completeRaceVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: completeRaceJob.id, businessId: businessA.id },
  });
  const completeRaceJobAfter = await prisma.job.findFirst({
    where: { id: completeRaceJob.id, businessId: businessA.id },
    select: { status: true },
  });
  const completeRaceKitchen = JSON.parse(completeRaceVisit.checklistJson).find(
    (item) => item.key === "kitchen",
  )?.checked;
  check(
    "Sync vs completeJobWithRunningTimeSafety serializes to closed/stale 409 or one write, with no lost write",
    ((completeRaceSync.ok === true &&
      completeRaceKitchen === true &&
      completeRaceWrite.ok === true) ||
      (completeRaceSync.ok === false &&
        completeRaceSync.status === 409 &&
        (completeRaceSync.error === NATIVE_CHECKLIST_CLOSED_MESSAGE ||
          completeRaceSync.error === NATIVE_CHECKLIST_STALE_MESSAGE) &&
        completeRaceKitchen === false &&
        completeRaceWrite.ok === true)) &&
      completeRaceJobAfter?.status === "COMPLETED",
  );

  const attachRaceExpected = expectedFrom(
    await loadNativeAssignedJob(prisma, memberAccess.access, attachRaceJob.id),
  );
  const waitAttach = createTwoPartyBarrier();
  const [attachRaceSync, attachRaceWrite] = await Promise.all([
    syncNativeAssignedChecklistDraft(
      prisma,
      memberAccess.access,
      attachRaceJob.id,
      syncPayload(attachRaceExpected, [
        { itemKey: "kitchen", checked: true, baseChecked: false },
      ]),
      { afterInitialRead: waitAttach },
    ),
    attachCleaningCrewChecklist(prisma, ownerA, {
      jobId: attachRaceJob.id,
      procedureId: attachProcedure.id,
      afterInitialRead: waitAttach,
    })
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error })),
  ]);
  const attachRaceVisit = await prisma.jobCrewVisit.findFirst({
    where: { jobId: attachRaceJob.id, businessId: businessA.id },
  });
  const attachRaceItems = JSON.parse(attachRaceVisit.checklistJson);
  const attachWon = attachRaceItems.every((item) => item.key !== "kitchen");
  const syncWonAlone =
    attachRaceSync.ok === true &&
    attachRaceItems.find((item) => item.key === "kitchen")?.checked === true;
  check(
    "Sync vs OWNER attachCleaningCrewChecklist serializes to stale 409 or one write, with no lost write",
    attachRaceWrite.ok === true &&
      ((attachRaceSync.ok === false &&
        attachRaceSync.status === 409 &&
        attachRaceSync.error === NATIVE_CHECKLIST_STALE_MESSAGE &&
        attachWon &&
        attachRaceItems.every((item) => item.checked === false)) ||
        (attachRaceSync.ok === true && (attachWon || syncWonAlone))),
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
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nNative field checklist offline check passed: local drafts, explicit sync, conflicts, auth, and isolation held."
    : `\n${failures} native field checklist offline check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
