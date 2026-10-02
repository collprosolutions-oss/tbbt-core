/**
 * Native assigned-job time-card local drafts + explicit sync.
 *
 * Reuses canonical time-card start/stop writes. Proves local
 * start/stop intents, explicit sync, two-device stale refusal,
 * retries, approved weeks, overlaps, timezone week bounds,
 * authorization, and real-device SecureStore limits.
 *
 * Run with:
 *   npm run test:native-field-time-offline
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { hashPassword } = await import("@/lib/auth-crypto");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const { NATIVE_JOB_NOT_AVAILABLE } = await import("@/lib/native-field-ops");
const { loadNativeAssignedJob } = await import("@/lib/native-field");
const {
  NATIVE_TIME_CARD_CHOOSE_INTENT,
  NATIVE_TIME_CARD_DURATION_TOO_LONG,
  NATIVE_TIME_CARD_DUPLICATE_MESSAGE,
  NATIVE_TIME_CARD_LOOKBACK_MS,
  NATIVE_TIME_CARD_MAX_INTENTS,
  NATIVE_TIME_CARD_OUT_OF_ORDER,
  NATIVE_TIME_CARD_STALE_MESSAGE,
  NATIVE_TIME_CARD_START_TOO_OLD,
  NATIVE_TIME_CARD_SYNC_JSON_MAX_BYTES,
  parseNativeTimeCardSyncJson,
  syncNativeAssignedTimeCardDraft,
  timeCardStateFingerprint,
} = await import("@/lib/native-field-time-sync");
const { resolveNativeFieldAccess, signInNativeField } = await import(
  "@/lib/native-session"
);
const { readCappedRequestText } = await import("@/lib/native-session-limits");
const { SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE } = await import(
  "@/lib/saas-billing/messages"
);
const { CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT } = await import(
  "@/lib/appointment-confirmation"
);
const { formatDateInput, formatTimeInput, parseBusinessDateTimeInput, weekRange } = await import(
  "@/lib/time-cards"
);
const {
  approveTimesheetWeek,
  startAssignedActivityTime,
  startJobWithRunningTimeSafety,
  START_EARLIER_THAN_RUNNING_ERROR,
  TIME_CORRECTION_FUTURE_SLACK_MS,
  TIME_CORRECTION_MAX_DURATION_MS,
} = await import("@/lib/time-card-ops");
const { requestNativeTimeCorrection } = await import("@/lib/native-time-cards");
const {
  SECURE_STORE_KEY_PATTERN,
  SECURE_STORE_VALUE_MAX_BYTES,
  TIME_CARD_DRAFT_DUPLICATE_TAP_MESSAGE,
  TIME_CARD_DRAFT_INDEX_KEY,
  TIME_CARD_DRAFT_INDEX_MAX_KEYS,
  TIME_CARD_DRAFT_INDEX_FULL_MESSAGE,
  TIME_CARD_DRAFT_MAX_INTENTS,
  TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES,
  applyTimeCardDraftAccount,
  applyTimeCardIntentsToSnapshot,
  clearAllTimeCardDrafts,
  createMemoryTimeCardDraftStorage,
  emptyTimeCardClockSnapshot,
  isSecureStoreKey,
  loadTimeCardDraft,
  persistLocalTimeCardIntent,
  recordLocalTimeCardIntent,
  storedByteLength,
  timeCardDraftStorageKey,
  timeCardSnapshotFromJob,
  timeCardStateFingerprint: nativeDraftFingerprint,
} = await import(new URL("../apps/native/src/time-card-drafts.ts", import.meta.url));

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

const testDbName = "tbbt_native_field_time_offline_test";
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
  console.error("Failed to push schema for native-field time-card offline test database.");
  dropTestDatabase();
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: testUrl });
const prismaRace = new PrismaClient({ datasourceUrl: testUrl });

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

function makeOwnerAccess(businessId, membershipId, timezone = "America/New_York") {
  return {
    businessId,
    workspace: {
      role: "OWNER",
      membership: { id: membershipId },
      user: { id: "owner", email: "owner@native-time-offline.example", name: "Owner" },
      business: { id: businessId, name: "Offline Time Co", timezone },
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

function civil(date, time, timeZone) {
  const parsedCivil = parseBusinessDateTimeInput(date, time, timeZone);
  if (!parsedCivil.ok) {
    throw new Error(`civil ${date} ${time} ${timeZone}: ${parsedCivil.error}`);
  }
  return parsedCivil.value;
}

const timeSyncSrc = readRepo("src/lib/native-field-time-sync.ts");
const timeSyncFnSrc = timeSyncSrc.slice(
  timeSyncSrc.indexOf("export async function syncNativeAssignedTimeCardDraft"),
);
const timeCardOpsSrc = readRepo("src/lib/time-card-ops.ts");
const offlineCheckSrc = readRepo("scripts/check-native-field-time-offline.mjs");
const appSrc = readRepo("apps/native/App.tsx");
const signInSrc = readRepo("apps/native/src/screens/SignInScreen.tsx");
const timeSyncRouteSrc = readRepo("src/app/api/native/v1/jobs/[jobId]/time/sync/route.ts");
const jobScreenSrc = readRepo("apps/native/src/screens/JobScreen.tsx");
const draftSrc = readRepo("apps/native/src/time-card-drafts.ts");
const nativeApiSrc = readRepo("apps/native/src/api.ts");
const docsSrc = readRepo("docs/NATIVE_FIELD.md");

console.log("\nSTATIC — Local drafts, explicit sync, and Job-screen isolation");
check(
  "Draft sync reuses canonical time-card writes, assignment lock, and expected-state recheck",
  timeSyncSrc.includes("syncNativeAssignedTimeCardDraft") &&
    timeSyncSrc.includes("lockTenantOwnedJob") &&
    timeSyncSrc.includes("assignedMembershipId") &&
    timeSyncSrc.includes("exactActiveMembershipHeld") &&
    timeSyncSrc.includes("NATIVE_TIME_CARD_STALE_MESSAGE") &&
    timeSyncSrc.includes("startJobWithRunningTimeSafetyInTransaction") &&
    timeSyncSrc.includes("stopRunningAssignedJobTimeInTransaction") &&
    timeSyncSrc.includes("startAssignedActivityTimeInTransaction") &&
    timeSyncSrc.includes("stopAssignedActivityTimeInTransaction") &&
    timeSyncSrc.includes("alreadySynced") &&
    timeSyncSrc.includes("NATIVE_TIME_CARD_DUPLICATE_MESSAGE") &&
    !timeSyncRouteSrc.includes("cookies(") &&
    timeSyncRouteSrc.includes("readBearerToken") &&
    timeSyncRouteSrc.includes("syncNativeAssignedTimeCardDraft") &&
    timeSyncFnSrc.indexOf("lockTenantOwnedJob") <
      timeSyncFnSrc.indexOf("exactActiveMembershipHeld") &&
    timeSyncFnSrc.indexOf("exactActiveMembershipHeld") <
      timeSyncFnSrc.indexOf("applyIntent") &&
    timeCardOpsSrc.includes("startJobWithRunningTimeSafetyInTransaction"),
);
check(
  "Native Job screen records offline start/stop locally, marks unsynced, and syncs only on tap",
  jobScreenSrc.includes("Unsynced time · Saved on this phone") &&
    jobScreenSrc.includes("not approved server time") &&
    jobScreenSrc.includes("Sync time") &&
    jobScreenSrc.includes("Saved on this phone") &&
    jobScreenSrc.includes("persistLocalTimeCardIntent") &&
    jobScreenSrc.includes("syncNativeJobTimeDraft") &&
    jobScreenSrc.includes("isNativeNetworkError") &&
    jobScreenSrc.includes("NATIVE_TIME_CARD_OFFLINE_MESSAGE") &&
    jobScreenSrc.includes("changed after your draft") &&
    jobScreenSrc.includes("Sync or discard unsynced time before completing this job.") &&
    jobScreenSrc.includes("Sync or discard unsynced time before recording a visit outcome.") &&
    nativeApiSrc.includes("/time/sync") &&
    nativeApiSrc.includes("NATIVE_TIME_CARD_OFFLINE_MESSAGE") &&
    draftSrc.includes("createMemoryTimeCardDraftStorage") &&
    draftSrc.includes("clearAllTimeCardDrafts") &&
    draftSrc.includes("TIME_CARD_DRAFT_DUPLICATE_TAP_MESSAGE") &&
    draftSrc.indexOf("await rememberDraftKey(storage, key)") <
      draftSrc.indexOf("await storage.write(key, payload)") &&
    TIME_CARD_DRAFT_MAX_INTENTS === NATIVE_TIME_CARD_MAX_INTENTS &&
    TIME_CARD_DRAFT_MAX_INTENTS === 4,
);
check(
  "Docs describe unsynced time, stale refusal, and the dedicated check",
  docsSrc.includes("Unsynced time") &&
    docsSrc.includes("Sync time") &&
    docsSrc.includes("refuses a stale or reassigned draft") &&
    docsSrc.includes("never approved server time") &&
    docsSrc.includes("test:native-field-time-offline"),
);
check(
  "Test database is dropped before create and after a failed db push",
  offlineCheckSrc.includes('DROP DATABASE IF EXISTS "${testDbName}"') &&
    offlineCheckSrc.indexOf("dropTestDatabase()") <
      offlineCheckSrc.indexOf('CREATE DATABASE "${testDbName}"') &&
    /if \(push\.status !== 0\) \{[\s\S]*dropTestDatabase\(\);[\s\S]*process\.exit/.test(
      offlineCheckSrc,
    ),
);
const liveOverlapSection = offlineCheckSrc.slice(
  offlineCheckSrc.indexOf("LIVE — Sync, retry, two-device conflict, overlap, timezone"),
);
const leftoverCollisionIdx = liveOverlapSection.indexOf(
  "Leftover overlap seed 409s a colliding same-worker correction",
);
const leftoverIsolationSlice = liveOverlapSection.slice(
  leftoverCollisionIdx,
  liveOverlapSection.indexOf("Older edits go through a correction request"),
);
check(
  "Pinned same-worker correction isolates the leftover overlap seed before retry",
  leftoverCollisionIdx !== -1 &&
    liveOverlapSection.includes("2026-10-02T11:45:00.000Z") &&
    liveOverlapSection.includes("That correction would overlap another entry.") &&
    leftoverIsolationSlice.includes("deleteMany") &&
    leftoverIsolationSlice.includes("jobId: overlapJob.id") &&
    leftoverIsolationSlice.includes("After isolating the leftover overlap seed"),
);
check(
  "Sign-out clears time drafts; restore 401/403 does not",
  appSrc.includes("clearAllTimeCardDrafts") &&
    appSrc.includes("applyTimeCardDraftAccount") &&
    appSrc.includes("restored.status === 401") &&
    appSrc.includes("restored.status === 403") &&
    !appSrc
      .slice(appSrc.indexOf("if (isApiError(restored))"), appSrc.indexOf("} else {"))
      .includes("clearAllTimeCardDrafts") &&
    signInSrc.includes("applyTimeCardDraftAccount") &&
    !signInSrc.includes("clearAllTimeCardDrafts(") &&
    offlineCheckSrc.includes("new PrismaClient({ datasourceUrl: testUrl })") &&
    offlineCheckSrc.includes("prismaRace") &&
    offlineCheckSrc.includes("Two-party barrier timed out"),
);

const idle = emptyTimeCardClockSnapshot("SCHEDULED", "mem-a");
const startAt = "2026-10-02T16:00:00.000Z";
const emptySync = parseNativeTimeCardSyncJson("{}");
const validSync = parseNativeTimeCardSyncJson(
  JSON.stringify({
    expectedFingerprint: timeCardStateFingerprint(idle),
    intents: [{ action: "START_JOB", intendedAt: startAt }],
  }),
  new Date("2026-10-02T16:05:00.000Z"),
);
check(
  "Sync JSON requires a fingerprint plus at least one start or stop intent",
  emptySync.ok === false &&
    emptySync.error === NATIVE_TIME_CARD_CHOOSE_INTENT &&
    validSync.ok === true &&
    validSync.intents[0].action === "START_JOB" &&
    validSync.expectedFingerprint === timeCardStateFingerprint(idle) &&
    nativeDraftFingerprint(idle) === timeCardStateFingerprint(idle),
);

const boundNow = new Date("2026-10-02T17:00:00.000Z");
function parseBoundIntent(intendedAt) {
  return parseNativeTimeCardSyncJson(
    JSON.stringify({
      expectedFingerprint: timeCardStateFingerprint(idle),
      intents: [{ action: "START_JOB", intendedAt }],
    }),
    boundNow,
  );
}
const futureInside = parseBoundIntent(
  new Date(boundNow.getTime() + TIME_CORRECTION_FUTURE_SLACK_MS).toISOString(),
);
const futureOutside = parseBoundIntent(
  new Date(boundNow.getTime() + TIME_CORRECTION_FUTURE_SLACK_MS + 1000).toISOString(),
);
const pastInside = parseBoundIntent(
  new Date(boundNow.getTime() - NATIVE_TIME_CARD_LOOKBACK_MS).toISOString(),
);
const pastOutside = parseBoundIntent(
  new Date(boundNow.getTime() - NATIVE_TIME_CARD_LOOKBACK_MS - 1000).toISOString(),
);
check(
  "parseNativeTimeCardSyncJson accepts a start just inside the 5-minute future slack",
  futureInside.ok === true &&
    NATIVE_TIME_CARD_LOOKBACK_MS === TIME_CORRECTION_MAX_DURATION_MS &&
    TIME_CORRECTION_FUTURE_SLACK_MS === 5 * 60 * 1000,
);
check(
  "parseNativeTimeCardSyncJson refuses a start just outside the 5-minute future slack",
  futureOutside.ok === false &&
    futureOutside.status === 400 &&
    futureOutside.error === NATIVE_TIME_CARD_CHOOSE_INTENT,
);
check(
  "parseNativeTimeCardSyncJson accepts a start just inside the 24-hour offline window",
  pastInside.ok === true,
);
check(
  "parseNativeTimeCardSyncJson refuses a start just outside the 24-hour offline window",
  pastOutside.ok === false &&
    pastOutside.status === 400 &&
    pastOutside.error === NATIVE_TIME_CARD_START_TOO_OLD,
);

const outOfOrderParse = parseNativeTimeCardSyncJson(
  JSON.stringify({
    expectedFingerprint: timeCardStateFingerprint(idle),
    intents: [
      { action: "START_TRAVEL", intendedAt: "2026-10-02T16:50:00.000Z" },
      { action: "START_JOB", intendedAt: "2026-10-02T16:40:00.000Z" },
    ],
  }),
  boundNow,
);
check(
  "parseNativeTimeCardSyncJson refuses a later tap that is earlier than the previous intendedAt",
  outOfOrderParse.ok === false &&
    outOfOrderParse.status === 400 &&
    outOfOrderParse.error === NATIVE_TIME_CARD_OUT_OF_ORDER,
);

const oversizedBody = await readCappedRequestText(
  new Request("http://native.test/api/native/v1/jobs/job/time/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(NATIVE_TIME_CARD_SYNC_JSON_MAX_BYTES + 1),
  }),
  NATIVE_TIME_CARD_SYNC_JSON_MAX_BYTES,
);
check(
  "Oversized time-card sync JSON body is rejected before parse",
  oversizedBody.ok === false && oversizedBody.status === 413,
);

console.log("\nLOCAL — Draft persist, reload, isolation, and storage limits");
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
const storageA = createMemoryTimeCardDraftStorage(shared);
const storageReload = createMemoryTimeCardDraftStorage(shared);
const first = await persistLocalTimeCardIntent(storageA, {
  scope,
  snapshot: idle,
  action: "START_JOB",
  now: new Date(startAt),
});
const reloaded = await loadTimeCardDraft(storageReload, scope);
const otherTenant = await loadTimeCardDraft(storageReload, otherScope);
let duplicateError = null;
try {
  recordLocalTimeCardIntent({
    scope,
    snapshot: idle,
    draft: reloaded,
    action: "START_JOB",
    now: new Date("2026-10-02T16:10:00.000Z"),
  });
} catch (error) {
  duplicateError = error;
}
const withStop = recordLocalTimeCardIntent({
  scope,
  snapshot: idle,
  draft: reloaded,
  action: "STOP_JOB_TIME",
  now: new Date("2026-10-02T18:00:00.000Z"),
});
let localOutOfOrderError = null;
try {
  recordLocalTimeCardIntent({
    scope,
    snapshot: idle,
    draft: withStop,
    action: "START_TRAVEL",
    now: new Date("2026-10-02T17:00:00.000Z"),
  });
} catch (error) {
  localOutOfOrderError = error;
}
check(
  "recordLocalTimeCardIntent refuses an intendedAt that is not after the previous tap",
  localOutOfOrderError instanceof Error &&
    localOutOfOrderError.message === TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES &&
    withStop.intents.length === 2,
);
check(
  "Assigned worker can record a local start intent",
  first?.intents.length === 1 &&
    first.intents[0].action === "START_JOB" &&
    first.intents[0].intendedAt === startAt &&
    first.expectedFingerprint === timeCardStateFingerprint(idle),
);
check(
  "Reloading the same scoped store keeps the unsynced start",
  reloaded?.intents[0].action === "START_JOB" &&
    reloaded.intents[0].intendedAt === startAt,
);
check(
  "Another business scope cannot read the draft",
  otherTenant === null &&
    timeCardDraftStorageKey(scope) !== timeCardDraftStorageKey(otherScope),
);
check(
  "A duplicate start tap is refused locally and stays unsynced",
  duplicateError instanceof Error &&
    duplicateError.message === TIME_CARD_DRAFT_DUPLICATE_TAP_MESSAGE &&
    withStop.intents.length === 2 &&
    withStop.intents[1].action === "STOP_JOB_TIME",
);

const cuidScope = {
  businessId: "clxyz0123456789abcdefghij",
  membershipId: "mem_field-worker.1",
  jobId: "550e8400-e29b-41d4-a716-446655440000",
};
const generatedKeys = [
  timeCardDraftStorageKey(scope),
  timeCardDraftStorageKey(otherScope),
  timeCardDraftStorageKey(cuidScope),
  TIME_CARD_DRAFT_INDEX_KEY,
];
check(
  "Every generated draft key is a valid expo-secure-store key",
  generatedKeys.every((key) => SECURE_STORE_KEY_PATTERN.test(key) && isSecureStoreKey(key)) &&
    !SECURE_STORE_KEY_PATTERN.test("tbbt.native.timecard.draft:biz-a:mem-a:job-a"),
);

const indexed = createMemoryTimeCardDraftStorage();
await persistLocalTimeCardIntent(indexed, {
  scope,
  snapshot: idle,
  action: "START_JOB",
  now: new Date(startAt),
});
await persistLocalTimeCardIntent(indexed, {
  scope: otherScope,
  snapshot: idle,
  action: "STOP_JOB_TIME",
  now: new Date("2026-10-02T18:00:00.000Z"),
});
const beforeClear = await Promise.all([
  loadTimeCardDraft(indexed, scope),
  loadTimeCardDraft(indexed, otherScope),
]);
await clearAllTimeCardDrafts(indexed);
const afterClear = await Promise.all([
  loadTimeCardDraft(indexed, scope),
  loadTimeCardDraft(indexed, otherScope),
]);
check(
  "Sign-out clears every indexed time-card draft",
  beforeClear.every((row) => row !== null) && afterClear.every((row) => row === null),
);

const compactStorage = createMemoryTimeCardDraftStorage();
const compact = await persistLocalTimeCardIntent(compactStorage, {
  scope: cuidScope,
  snapshot: timeCardSnapshotFromJob({
    jobStatus: "SCHEDULED",
    assignmentId: cuidScope.membershipId,
    runningTime: { running: false, startedAt: null, endedAt: null },
  }),
  action: "START_JOB",
  now: new Date(startAt),
});
const compactRaw = await compactStorage.read(timeCardDraftStorageKey(cuidScope));
check(
  "A cuid-scoped start draft stays under the 2048-byte SecureStore value cap",
  compact?.intents.length === 1 &&
    storedByteLength(compactRaw ?? "") <= SECURE_STORE_VALUE_MAX_BYTES,
);

const overflowStorage = createMemoryTimeCardDraftStorage();
const overflowScope = { ...scope, jobId: "job-overflow" };
await persistLocalTimeCardIntent(overflowStorage, {
  scope: overflowScope,
  snapshot: idle,
  action: "START_JOB",
  now: new Date(startAt),
});
await persistLocalTimeCardIntent(overflowStorage, {
  scope: overflowScope,
  snapshot: idle,
  action: "STOP_JOB_TIME",
  now: new Date("2026-10-02T17:00:00.000Z"),
});
await persistLocalTimeCardIntent(overflowStorage, {
  scope: overflowScope,
  snapshot: idle,
  action: "START_TRAVEL",
  now: new Date("2026-10-02T17:05:00.000Z"),
});
await persistLocalTimeCardIntent(overflowStorage, {
  scope: overflowScope,
  snapshot: idle,
  action: "STOP_TRAVEL",
  now: new Date("2026-10-02T17:20:00.000Z"),
});
let overflowError = null;
try {
  await persistLocalTimeCardIntent(overflowStorage, {
    scope: overflowScope,
    snapshot: idle,
    action: "START_PICKUP",
    now: new Date("2026-10-02T17:25:00.000Z"),
  });
} catch (error) {
  overflowError = error;
}
const overflowKept = await loadTimeCardDraft(overflowStorage, overflowScope);
check(
  "A draft that cannot fit more changes says sync before more changes and keeps prior taps",
  overflowError instanceof Error &&
    overflowError.message === TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES &&
    overflowKept?.intents.length === 4,
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
await persistLocalTimeCardIntent(indexFirstStorage, {
  scope,
  snapshot: idle,
  action: "START_JOB",
  now: new Date(startAt),
});
check(
  "Draft index is written before the draft payload",
  indexOrder[0] === TIME_CARD_DRAFT_INDEX_KEY &&
    indexOrder[1] === timeCardDraftStorageKey(scope),
);

const capStorage = createMemoryTimeCardDraftStorage();
let capError = null;
for (let index = 0; index < TIME_CARD_DRAFT_INDEX_MAX_KEYS + 1; index += 1) {
  try {
    await persistLocalTimeCardIntent(capStorage, {
      scope: { ...scope, jobId: `job-cap-${index}` },
      snapshot: idle,
      action: "START_JOB",
      now: new Date(startAt),
    });
  } catch (error) {
    capError = error;
  }
}
const firstCapped = await loadTimeCardDraft(capStorage, {
  ...scope,
  jobId: "job-cap-0",
});
check(
  "The draft index stays under 2048 bytes and refuses a 17th job with a clear message",
  capError instanceof Error &&
    capError.message === TIME_CARD_DRAFT_INDEX_FULL_MESSAGE &&
    firstCapped?.intents[0].action === "START_JOB",
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
  await clearAllTimeCardDrafts(explodingStorage);
} catch {
  clearThrew = true;
}
check("clearAllTimeCardDrafts never throws", clearThrew === false);

const accountStorage = createMemoryTimeCardDraftStorage();
await persistLocalTimeCardIntent(accountStorage, {
  scope,
  snapshot: idle,
  action: "START_JOB",
  now: new Date(startAt),
});
await applyTimeCardDraftAccount(accountStorage, {
  businessId: scope.businessId,
  membershipId: scope.membershipId,
});
const sameAccountDraft = await loadTimeCardDraft(accountStorage, scope);
await applyTimeCardDraftAccount(accountStorage, {
  businessId: scope.businessId,
  membershipId: scope.membershipId,
});
const stillSameAccountDraft = await loadTimeCardDraft(accountStorage, scope);
await applyTimeCardDraftAccount(accountStorage, {
  businessId: "biz-other",
  membershipId: "mem-other",
});
const switchedAccountDraft = await loadTimeCardDraft(accountStorage, scope);
check(
  "Sign-in keeps drafts for the same business+membership and clears only on account switch",
  sameAccountDraft?.intents[0].action === "START_JOB" &&
    stillSameAccountDraft?.intents[0].action === "START_JOB" &&
    switchedAccountDraft === null,
);

const desiredStart = applyTimeCardIntentsToSnapshot(idle, [
  { action: "START_JOB", intendedAt: startAt },
]);
check(
  "Applying a start intent does not mark the overlay as recorded server time",
  desiredStart.clocks.JOB.running === true &&
    desiredStart.jobStatus === "IN_PROGRESS" &&
    desiredStart.clocks.JOB.startedAt === startAt &&
    desiredStart.clocks.JOB.endedAt === null,
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
  const password = "native-time-offline-pass-9";
  const passwordHash = await hashPassword(password);

  const businessA = await prisma.business.create({
    data: {
      name: "Alpha Native Time Offline",
      slug: `alpha-native-time-off-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      ...completedOnboarding,
    },
  });
  const businessB = await prisma.business.create({
    data: {
      name: "Beta Native Time Offline",
      slug: `beta-native-time-off-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      ...completedOnboarding,
    },
  });
  const blockedBusiness = await prisma.business.create({
    data: {
      name: "Blocked Native Time Offline",
      slug: `blocked-native-time-off-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: "America/New_York",
      ...completedOnboarding,
    },
  });
  const laBusiness = await prisma.business.create({
    data: {
      name: "LA Native Time Offline",
      slug: `la-native-time-off-${randomUUID()}`,
      tradeCode: "HANDYMAN",
      timezone: "America/Los_Angeles",
      ...completedOnboarding,
    },
  });

  const ownerUser = await prisma.user.create({
    data: {
      name: "Olivia Owner",
      email: `owner-${randomUUID()}@native-time-offline.example`,
      passwordHash,
    },
  });
  const memberUser = await prisma.user.create({
    data: {
      name: "Mia Member",
      email: `mia-${randomUUID()}@native-time-offline.example`,
      passwordHash,
    },
  });
  const otherUser = await prisma.user.create({
    data: {
      name: "Max Other",
      email: `max-${randomUUID()}@native-time-offline.example`,
      passwordHash,
    },
  });
  const betaUser = await prisma.user.create({
    data: {
      name: "Bree Beta",
      email: `bree-${randomUUID()}@beta-time-offline.example`,
      passwordHash,
    },
  });
  const blockedUser = await prisma.user.create({
    data: {
      name: "Blocked Member",
      email: `blocked-${randomUUID()}@native-time-offline.example`,
      passwordHash,
    },
  });
  const laUser = await prisma.user.create({
    data: {
      name: "Lane LA",
      email: `lane-${randomUUID()}@la-time-offline.example`,
      passwordHash,
    },
  });
  const deactivateUser = await prisma.user.create({
    data: {
      name: "Dee Deactivate",
      email: `dee-${randomUUID()}@native-time-offline.example`,
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
  const laOwnerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: laBusiness.id, role: "OWNER" },
  });
  const laMem = await prisma.membership.create({
    data: { userId: laUser.id, businessId: laBusiness.id, role: "MEMBER" },
  });
  const deactivateMem = await prisma.membership.create({
    data: { userId: deactivateUser.id, businessId: businessA.id, role: "MEMBER" },
  });

  await prisma.businessSaasSubscription.create({
    data: { businessId: businessA.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: businessB.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
  });
  await prisma.businessSaasSubscription.create({
    data: { businessId: laBusiness.id, status: "active", planCode: "FOUNDER", legacyExempt: true },
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

  const ownerA = makeOwnerAccess(businessA.id, ownerMem.id, "America/New_York");
  const ownerLa = makeOwnerAccess(laBusiness.id, laOwnerMem.id, "America/Los_Angeles");

  function confirmedStartFields() {
    return {
      scheduledAt: new Date(),
      scheduledDurationMinutes: 60,
      appointmentProposalId: 1,
      appointmentConfirmationStatus: "CONFIRMED",
      appointmentConfirmedForProposalId: 1,
      appointmentConfirmationSource: "PORTAL",
      propertyAccessMethod: "CUSTOMER_PRESENT",
    };
  }

  async function createTimeJob(input) {
    const customer = await prisma.customer.create({
      data: {
        businessId: input.businessId,
        name: input.customerName ?? "Time Offline Customer",
        phone: "555-0142",
      },
    });
    return prisma.job.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        assignedMembershipId: input.assignedMembershipId ?? null,
        projectToken: randomUUID(),
        status: input.status ?? "SCHEDULED",
        ...confirmedStartFields(),
        ...(input.unconfirmed
          ? {
              appointmentConfirmationStatus: "AWAITING_CUSTOMER",
              appointmentConfirmedForProposalId: null,
            }
          : {}),
      },
    });
  }

  async function createReadyEntry(input) {
    return prisma.timeEntry.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId ?? null,
        activityType: input.activityType ?? "JOB",
        status: "READY",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        source: "CLOCK",
      },
    });
  }

  async function createRunningEntry(input) {
    return prisma.timeEntry.create({
      data: {
        businessId: input.businessId,
        membershipId: input.membershipId,
        jobId: input.jobId,
        activityType: input.activityType ?? "JOB",
        status: "RUNNING",
        startedAt: input.startedAt ?? new Date(Date.now() - 90_000),
        source: "CLOCK",
      },
    });
  }

  const memberJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Start Sync Canary",
  });
  const stopJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Stop Sync Canary",
    status: "IN_PROGRESS",
  });
  const stopStartedAt = new Date("2026-10-02T14:00:00.000Z");
  const retryJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Retry Sync Canary",
  });
  const conflictJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Two Device Canary",
  });
  const concurrentJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Concurrent Sync Canary",
  });
  const overlapJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Overlap Canary",
  });
  const overlapStartedAt = "2026-10-02T12:00:00.000Z";
  const overlapEndedAt = "2026-10-02T13:00:00.000Z";
  const overlapIntentAt = "2026-10-02T12:30:00.000Z";
  const earlierRunningJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Earlier Running Canary",
    status: "IN_PROGRESS",
  });
  const earlierStartJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Earlier Start Canary",
  });
  const outOfOrderJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Out Of Order Canary",
  });
  const oldStartJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Old Start Canary",
  });
  const longStopJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Long Stop Canary",
    status: "IN_PROGRESS",
  });
  const correctionJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Correction Path Canary",
    status: "IN_PROGRESS",
  });
  const deactivateJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: deactivateMem.id,
    customerName: "Deactivate Canary",
  });
  const raceJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Reassign Canary",
  });
  const otherJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: otherMem.id,
    customerName: "Other Worker Canary",
  });
  const unassignedJob = await createTimeJob({
    businessId: businessA.id,
    customerName: "Unassigned Canary",
  });
  const betaJob = await createTimeJob({
    businessId: businessB.id,
    assignedMembershipId: betaMem.id,
    customerName: "Beta Canary",
  });
  const blockedJob = await createTimeJob({
    businessId: blockedBusiness.id,
    assignedMembershipId: blockedMem.id,
    customerName: "Blocked Canary",
  });
  const unconfirmedJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Unconfirmed Canary",
    unconfirmed: true,
  });
  const startStopJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Start Stop Canary",
  });
  const approvedJob = await createTimeJob({
    businessId: laBusiness.id,
    assignedMembershipId: laMem.id,
    customerName: "Approved Week Canary",
  });
  const openWeekJob = await createTimeJob({
    businessId: laBusiness.id,
    assignedMembershipId: laMem.id,
    customerName: "Open Week Canary",
  });

  const memberSignIn = await signInNativeField(prisma, {
    email: memberUser.email,
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
  const laSignIn = await signInNativeField(prisma, {
    email: laUser.email,
    password,
  });
  const deactivateSignIn = await signInNativeField(prisma, {
    email: deactivateUser.email,
    password,
  });
  if (
    !memberSignIn.ok ||
    !otherSignIn.ok ||
    !betaSignIn.ok ||
    !blockedSignIn.ok ||
    !laSignIn.ok ||
    !deactivateSignIn.ok
  ) {
    throw new Error("Time-card offline fixture sign-in failed.");
  }
  const memberAccess = await resolveNativeFieldAccess(prisma, { token: memberSignIn.token });
  const otherAccess = await resolveNativeFieldAccess(prisma, { token: otherSignIn.token });
  const betaAccess = await resolveNativeFieldAccess(prisma, { token: betaSignIn.token });
  const blockedAccess = await resolveNativeFieldAccess(prisma, { token: blockedSignIn.token });
  const laAccess = await resolveNativeFieldAccess(prisma, { token: laSignIn.token });
  const deactivateAccess = await resolveNativeFieldAccess(prisma, {
    token: deactivateSignIn.token,
  });
  if (
    !memberAccess.ok ||
    !otherAccess.ok ||
    !betaAccess.ok ||
    !blockedAccess.ok ||
    !laAccess.ok ||
    !deactivateAccess.ok
  ) {
    throw new Error("Time-card offline fixture access failed.");
  }

  function snapshotFor(job, assignmentId, extra = {}) {
    return {
      jobStatus: job.status,
      assignmentId,
      runningTime: extra.runningTime ?? { running: false, startedAt: null, endedAt: null },
      travelTime: extra.travelTime ?? { running: false, startedAt: null, endedAt: null },
      pickupTime: extra.pickupTime ?? { running: false, startedAt: null, endedAt: null },
    };
  }

  function syncPayload(job, assignmentId, intents, extra) {
    return {
      expectedFingerprint: timeCardStateFingerprint(
        timeCardSnapshotFromJob(snapshotFor(job, assignmentId, extra)),
      ),
      intents,
    };
  }

  console.log("\nAUTH — Assignment, tenant, and subscription refusals");
  const stolen = await syncNativeAssignedTimeCardDraft(
    prisma,
    otherAccess.access,
    memberJob.id,
    syncPayload(memberJob, otherMem.id, [
      { action: "START_JOB", intendedAt: startAt },
    ]),
  );
  const cross = await syncNativeAssignedTimeCardDraft(
    prisma,
    betaAccess.access,
    memberJob.id,
    syncPayload(memberJob, betaMem.id, [
      { action: "START_JOB", intendedAt: startAt },
    ]),
  );
  const unassigned = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    unassignedJob.id,
    syncPayload(unassignedJob, memberMem.id, [
      { action: "START_JOB", intendedAt: startAt },
    ]),
  );
  const blockedWrite = await syncNativeAssignedTimeCardDraft(
    prisma,
    blockedAccess.access,
    blockedJob.id,
    syncPayload(blockedJob, blockedMem.id, [
      { action: "START_JOB", intendedAt: startAt },
    ]),
  );
  check(
    "Another worker cannot sync a time draft on this job",
    stolen.ok === false && stolen.status === 404 && stolen.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Cross-tenant worker cannot sync a time draft",
    cross.ok === false && cross.status === 404 && cross.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Unassigned job refuses time-card sync",
    unassigned.ok === false &&
      unassigned.status === 404 &&
      unassigned.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Time-card sync requires an operating SaaS subscription",
    blockedWrite.ok === false &&
      blockedWrite.status === 403 &&
      blockedWrite.error === SAAS_SUBSCRIPTION_REQUIRED_TEAM_MESSAGE,
  );

  console.log("\nLIVE — Sync, retry, two-device conflict, overlap, timezone");
  // Overlap runs first with its own closed interval so later start/stop
  // fixtures do not share the same worker clock window. That seed stays
  // on this worker until the correction regression isolates it.
  await createReadyEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: overlapJob.id,
    startedAt: new Date(overlapStartedAt),
    endedAt: new Date(overlapEndedAt),
  });
  const overlap = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    overlapJob.id,
    syncPayload(
      overlapJob,
      memberMem.id,
      [{ action: "START_JOB", intendedAt: overlapIntentAt }],
      {
        runningTime: {
          running: false,
          startedAt: overlapStartedAt,
          endedAt: overlapEndedAt,
        },
      },
    ),
  );
  const overlapRows = await prisma.timeEntry.findMany({
    where: { jobId: overlapJob.id, businessId: businessA.id, status: "RUNNING" },
  });
  check(
    "An overlapping offline start is refused visibly and writes no running time",
    overlap.ok === false &&
      overlap.status === 409 &&
      String(overlap.error).includes("overlaps") &&
      overlapRows.length === 0,
  );
  const overlapSeed = await prisma.timeEntry.findMany({
    where: { jobId: overlapJob.id, businessId: businessA.id },
  });
  check(
    "The refused overlapping start leaves the original closed seed and no merged running clock",
    overlapSeed.length === 1 &&
      overlapSeed[0].status === "READY" &&
      overlapSeed[0].startedAt.toISOString() === overlapStartedAt &&
      overlapSeed[0].endedAt?.toISOString() === overlapEndedAt,
  );

  const clockNow = new Date();
  const runningSince = new Date(clockNow.getTime() - 30 * 60 * 1000);
  const earlierStartAt = new Date(clockNow.getTime() - 2 * 60 * 60 * 1000).toISOString();
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: earlierRunningJob.id,
    startedAt: runningSince,
  });
  const earlierStart = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    earlierStartJob.id,
    syncPayload(earlierStartJob, memberMem.id, [
      { action: "START_JOB", intendedAt: earlierStartAt },
    ]),
  );
  const earlierRunningAfter = await prisma.timeEntry.findMany({
    where: { jobId: earlierRunningJob.id, businessId: businessA.id },
  });
  const earlierStartRows = await prisma.timeEntry.findMany({
    where: { jobId: earlierStartJob.id, businessId: businessA.id },
  });
  check(
    "A start earlier than time already running is a visible 409 and writes no negative duration",
    earlierStart.ok === false &&
      earlierStart.status === 409 &&
      earlierStart.error === START_EARLIER_THAN_RUNNING_ERROR &&
      earlierStartRows.length === 0 &&
      earlierRunningAfter.length === 1 &&
      earlierRunningAfter[0].status === "RUNNING" &&
      earlierRunningAfter[0].endedAt === null &&
      earlierRunningAfter[0].startedAt.getTime() === runningSince.getTime(),
  );
  await prisma.timeEntry.deleteMany({
    where: { jobId: earlierRunningJob.id, businessId: businessA.id },
  });

  const travelEarlier = new Date(clockNow.getTime() - 10 * 60 * 1000).toISOString();
  const jobEarlier = new Date(clockNow.getTime() - 20 * 60 * 1000).toISOString();
  const outOfOrderLive = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    outOfOrderJob.id,
    syncPayload(outOfOrderJob, memberMem.id, [
      { action: "START_TRAVEL", intendedAt: travelEarlier },
      { action: "START_JOB", intendedAt: jobEarlier },
    ]),
  );
  const outOfOrderRows = await prisma.timeEntry.findMany({
    where: { jobId: outOfOrderJob.id, businessId: businessA.id },
  });
  check(
    "An out-of-order travel-then-job draft is refused and writes no negative-duration travel",
    outOfOrderLive.ok === false &&
      outOfOrderLive.status === 400 &&
      outOfOrderLive.error === NATIVE_TIME_CARD_OUT_OF_ORDER &&
      outOfOrderRows.length === 0,
  );

  const eightyDaysAgo = new Date(clockNow.getTime() - 80 * 24 * 60 * 60 * 1000).toISOString();
  const oldStart = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    oldStartJob.id,
    syncPayload(oldStartJob, memberMem.id, [
      { action: "START_JOB", intendedAt: eightyDaysAgo },
    ]),
  );
  const oldStartRows = await prisma.timeEntry.findMany({
    where: { jobId: oldStartJob.id, businessId: businessA.id },
  });
  check(
    "An 80-day-old start is refused and does not create unreviewed time",
    oldStart.ok === false &&
      oldStart.status === 400 &&
      oldStart.error === NATIVE_TIME_CARD_START_TOO_OLD &&
      oldStartRows.length === 0,
  );

  const longStartedAt = new Date(clockNow.getTime() - TIME_CORRECTION_MAX_DURATION_MS - 60_000);
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: longStopJob.id,
    startedAt: longStartedAt,
  });
  const longStop = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    longStopJob.id,
    syncPayload(
      longStopJob,
      memberMem.id,
      [{ action: "STOP_JOB_TIME", intendedAt: clockNow.toISOString() }],
      {
        runningTime: {
          running: true,
          startedAt: longStartedAt.toISOString(),
          endedAt: null,
        },
      },
    ),
  );
  const longStopRows = await prisma.timeEntry.findMany({
    where: { jobId: longStopJob.id, businessId: businessA.id },
  });
  check(
    "A sync stop longer than 24 hours is refused and leaves the running entry open",
    longStop.ok === false &&
      longStop.status === 409 &&
      longStop.error === NATIVE_TIME_CARD_DURATION_TOO_LONG &&
      longStopRows.length === 1 &&
      longStopRows[0].status === "RUNNING" &&
      longStopRows[0].endedAt === null,
  );
  await prisma.timeEntry.deleteMany({
    where: { jobId: longStopJob.id, businessId: businessA.id },
  });

  const equalRunningAt = new Date(clockNow.getTime() - 30 * 60 * 1000);
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: earlierRunningJob.id,
    startedAt: equalRunningAt,
  });
  const equalStart = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    earlierStartJob.id,
    syncPayload(earlierStartJob, memberMem.id, [
      { action: "START_JOB", intendedAt: equalRunningAt.toISOString() },
    ]),
  );
  const equalStartRows = await prisma.timeEntry.findMany({
    where: { jobId: earlierStartJob.id, businessId: businessA.id },
  });
  const equalRunningAfter = await prisma.timeEntry.findMany({
    where: { jobId: earlierRunningJob.id, businessId: businessA.id },
  });
  check(
    "A start at the exact running startedAt is refused as earlier than time already running",
    equalStart.ok === false &&
      equalStart.status === 409 &&
      equalStart.error === START_EARLIER_THAN_RUNNING_ERROR &&
      equalStartRows.length === 0 &&
      equalRunningAfter.length === 1 &&
      equalRunningAfter[0].status === "RUNNING" &&
      equalRunningAfter[0].endedAt === null,
  );
  await prisma.timeEntry.deleteMany({
    where: { jobId: earlierRunningJob.id, businessId: businessA.id },
  });

  const thirtyHoursAgo = new Date(clockNow.getTime() - 30 * 60 * 60 * 1000);
  const forgottenJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Forgotten Live Job",
    status: "IN_PROGRESS",
  });
  const liveStartJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Start After Forgotten",
  });
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: forgottenJob.id,
    startedAt: thirtyHoursAgo,
  });
  const liveJobStart = await startJobWithRunningTimeSafety(prisma, {
    businessId: businessA.id,
    jobId: liveStartJob.id,
    actorMembershipId: memberMem.id,
    startedAt: clockNow,
  });
  const forgottenAfterLive = await prisma.timeEntry.findMany({
    where: { jobId: forgottenJob.id, businessId: businessA.id },
  });
  const liveStartRows = await prisma.timeEntry.findMany({
    where: { jobId: liveStartJob.id, businessId: businessA.id },
  });
  check(
    "Live Start job closes a forgotten 30-hour running entry at the new start time",
    liveJobStart.ok === true &&
      forgottenAfterLive.length === 1 &&
      forgottenAfterLive[0].status === "READY" &&
      forgottenAfterLive[0].endedAt?.getTime() === clockNow.getTime() &&
      liveStartRows.length === 1 &&
      liveStartRows[0].status === "RUNNING" &&
      liveStartRows[0].startedAt.getTime() === clockNow.getTime(),
  );
  await prisma.timeEntry.deleteMany({
    where: {
      id: { in: [...forgottenAfterLive, ...liveStartRows].map((row) => row.id) },
    },
  });

  const forgottenTravelSource = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Forgotten Live Travel Source",
    status: "IN_PROGRESS",
  });
  const liveTravelJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Live Travel After Forgotten",
    status: "IN_PROGRESS",
  });
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: forgottenTravelSource.id,
    startedAt: thirtyHoursAgo,
  });
  const liveTravelStart = await startAssignedActivityTime(prisma, {
    businessId: businessA.id,
    jobId: liveTravelJob.id,
    activityType: "TRAVEL",
    actorMembershipId: memberMem.id,
    startedAt: clockNow,
  });
  const forgottenTravelAfter = await prisma.timeEntry.findMany({
    where: { jobId: forgottenTravelSource.id, businessId: businessA.id },
  });
  const liveTravelRows = await prisma.timeEntry.findMany({
    where: { jobId: liveTravelJob.id, businessId: businessA.id },
  });
  check(
    "Live Start travel closes a forgotten 30-hour running entry at the new start time",
    liveTravelStart.ok === true &&
      forgottenTravelAfter.length === 1 &&
      forgottenTravelAfter[0].status === "READY" &&
      forgottenTravelAfter[0].endedAt?.getTime() === clockNow.getTime() &&
      liveTravelRows.length === 1 &&
      liveTravelRows[0].activityType === "TRAVEL" &&
      liveTravelRows[0].status === "RUNNING",
  );
  await prisma.timeEntry.deleteMany({
    where: {
      id: { in: [...forgottenTravelAfter, ...liveTravelRows].map((row) => row.id) },
    },
  });

  const forgottenSyncJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Forgotten Sync Start Source",
    status: "IN_PROGRESS",
  });
  const syncLongStartJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Sync Start After Forgotten",
  });
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: forgottenSyncJob.id,
    startedAt: thirtyHoursAgo,
  });
  const syncLongStart = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    syncLongStartJob.id,
    syncPayload(syncLongStartJob, memberMem.id, [
      { action: "START_JOB", intendedAt: clockNow.toISOString() },
    ]),
  );
  const forgottenSyncAfter = await prisma.timeEntry.findMany({
    where: { jobId: forgottenSyncJob.id, businessId: businessA.id },
  });
  const syncLongStartRows = await prisma.timeEntry.findMany({
    where: { jobId: syncLongStartJob.id, businessId: businessA.id },
  });
  check(
    "A sync START that would close a 30-hour running entry is refused with the correction message",
    syncLongStart.ok === false &&
      syncLongStart.status === 409 &&
      syncLongStart.error === NATIVE_TIME_CARD_DURATION_TOO_LONG &&
      forgottenSyncAfter.length === 1 &&
      forgottenSyncAfter[0].status === "RUNNING" &&
      forgottenSyncAfter[0].endedAt === null &&
      syncLongStartRows.length === 0,
  );
  await prisma.timeEntry.deleteMany({
    where: { jobId: forgottenSyncJob.id, businessId: businessA.id },
  });

  const longTravelJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Long Travel Stop",
    status: "IN_PROGRESS",
  });
  const longPickupJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Long Pickup Stop",
    status: "IN_PROGRESS",
  });
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: longTravelJob.id,
    activityType: "TRAVEL",
    startedAt: longStartedAt,
  });
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: longPickupJob.id,
    activityType: "MATERIAL_PICKUP",
    startedAt: longStartedAt,
  });
  const longTravelStop = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    longTravelJob.id,
    syncPayload(
      longTravelJob,
      memberMem.id,
      [{ action: "STOP_TRAVEL", intendedAt: clockNow.toISOString() }],
      {
        travelTime: {
          running: true,
          startedAt: longStartedAt.toISOString(),
          endedAt: null,
        },
      },
    ),
  );
  const longPickupStop = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    longPickupJob.id,
    syncPayload(
      longPickupJob,
      memberMem.id,
      [{ action: "STOP_PICKUP", intendedAt: clockNow.toISOString() }],
      {
        pickupTime: {
          running: true,
          startedAt: longStartedAt.toISOString(),
          endedAt: null,
        },
      },
    ),
  );
  const longTravelRows = await prisma.timeEntry.findMany({
    where: { jobId: longTravelJob.id, businessId: businessA.id },
  });
  const longPickupRows = await prisma.timeEntry.findMany({
    where: { jobId: longPickupJob.id, businessId: businessA.id },
  });
  check(
    "A TRAVEL sync stop longer than 24 hours is refused and leaves the running entry open",
    longTravelStop.ok === false &&
      longTravelStop.status === 409 &&
      longTravelStop.error === NATIVE_TIME_CARD_DURATION_TOO_LONG &&
      longTravelRows.length === 1 &&
      longTravelRows[0].status === "RUNNING",
  );
  check(
    "A PICKUP sync stop longer than 24 hours is refused and leaves the running entry open",
    longPickupStop.ok === false &&
      longPickupStop.status === 409 &&
      longPickupStop.error === NATIVE_TIME_CARD_DURATION_TOO_LONG &&
      longPickupRows.length === 1 &&
      longPickupRows[0].status === "RUNNING",
  );
  await prisma.timeEntry.deleteMany({
    where: {
      jobId: { in: [longTravelJob.id, longPickupJob.id] },
      businessId: businessA.id,
    },
  });

  const futureSync = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    oldStartJob.id,
    syncPayload(oldStartJob, memberMem.id, [
      {
        action: "START_JOB",
        intendedAt: new Date(
          clockNow.getTime() + TIME_CORRECTION_FUTURE_SLACK_MS + 1000,
        ).toISOString(),
      },
    ]),
  );
  check(
    "assertSyncIntendedAt refuses a sync start just outside the 5-minute future slack",
    futureSync.ok === false &&
      futureSync.status === 400 &&
      futureSync.error === NATIVE_TIME_CARD_CHOOSE_INTENT,
  );

  const replayAgedJob = await createTimeJob({
    businessId: businessA.id,
    assignedMembershipId: memberMem.id,
    customerName: "Aged Replay Canary",
  });
  const replayAgedAt = new Date(clockNow.getTime() - 60_000).toISOString();
  const replayAgedPayload = syncPayload(replayAgedJob, memberMem.id, [
    { action: "START_JOB", intendedAt: replayAgedAt },
  ]);
  const replayAgedFirst = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    replayAgedJob.id,
    replayAgedPayload,
  );
  const replayAgedSecond = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    replayAgedJob.id,
    replayAgedPayload,
    { now: new Date(clockNow.getTime() + 25 * 60 * 60 * 1000) },
  );
  const replayAgedRows = await prisma.timeEntry.findMany({
    where: { jobId: replayAgedJob.id, businessId: businessA.id },
  });
  check(
    "An exact replay is alreadySynced before the 24-hour intendedAt age check",
    replayAgedFirst.ok === true &&
      replayAgedFirst.alreadySynced === false &&
      replayAgedSecond.ok === true &&
      replayAgedSecond.alreadySynced === true &&
      replayAgedRows.length === 1,
  );
  await prisma.timeEntry.deleteMany({
    where: { jobId: replayAgedJob.id, businessId: businessA.id },
  });

  // A wall-clock "now" of 2026-10-02T20:00Z makes now-8h15m → now-7h
  // propose 11:45-13:00, which overlaps the leftover 12:00-13:00 seed.
  // That 409 is a fixture collision, not a merged offline-sync write.
  const correctionStart = new Date("2026-10-02T12:00:00.000Z");
  const correctionEnd = new Date("2026-10-02T13:00:00.000Z");
  const proposedCorrectionStart = new Date("2026-10-02T11:45:00.000Z");
  const correctionEntry = await createReadyEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: correctionJob.id,
    startedAt: correctionStart,
    endedAt: correctionEnd,
  });
  const collidingCorrectionInput = {
    timeEntryId: correctionEntry.id,
    reason: "Offline tap was older than the sync window.",
    proposedStartDate: formatDateInput(proposedCorrectionStart, "America/New_York"),
    proposedStartTime: formatTimeInput(proposedCorrectionStart, "America/New_York"),
    proposedEndDate: formatDateInput(correctionEnd, "America/New_York"),
    proposedEndTime: formatTimeInput(correctionEnd, "America/New_York"),
  };
  const leftoverOverlapCollision = await requestNativeTimeCorrection(
    prisma,
    memberAccess.access,
    collidingCorrectionInput,
  );
  check(
    "Leftover overlap seed 409s a colliding same-worker correction",
    leftoverOverlapCollision.ok === false &&
      leftoverOverlapCollision.status === 409 &&
      leftoverOverlapCollision.error === "That correction would overlap another entry.",
  );
  await prisma.timeEntry.deleteMany({
    where: { jobId: overlapJob.id, businessId: businessA.id },
  });
  const correctionRequest = await requestNativeTimeCorrection(
    prisma,
    memberAccess.access,
    collidingCorrectionInput,
  );
  const correctionAfter = await prisma.timeEntry.findFirst({
    where: { id: correctionEntry.id },
  });
  check(
    "After isolating the leftover overlap seed, the same correction is PENDING",
    correctionRequest.ok === true &&
      correctionRequest.request.status === "PENDING" &&
      correctionAfter?.startedAt.getTime() === correctionStart.getTime() &&
      correctionAfter?.endedAt?.getTime() === correctionEnd.getTime(),
  );
  check(
    "Older edits go through a correction request and do not rewrite the TimeEntry",
    correctionRequest.ok === true &&
      correctionRequest.request.status === "PENDING" &&
      correctionAfter?.startedAt.getTime() === correctionStart.getTime() &&
      correctionAfter?.endedAt?.getTime() === correctionEnd.getTime(),
  );

  const deactivate = await syncNativeAssignedTimeCardDraft(
    prisma,
    deactivateAccess.access,
    deactivateJob.id,
    syncPayload(deactivateJob, deactivateMem.id, [
      { action: "START_JOB", intendedAt: new Date(clockNow.getTime() - 60_000).toISOString() },
    ]),
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
  const deactivateRows = await prisma.timeEntry.findMany({
    where: { jobId: deactivateJob.id, businessId: businessA.id },
  });
  const deactivateJobAfter = await prisma.job.findFirst({
    where: { id: deactivateJob.id, businessId: businessA.id },
    select: { status: true, assignedMembershipId: true },
  });
  check(
    "A deactivated membership after the initial read refuses time-card sync with no writes",
    deactivate.ok === false &&
      deactivate.status === 404 &&
      deactivate.error === NATIVE_JOB_NOT_AVAILABLE &&
      deactivateRows.length === 0 &&
      deactivateJobAfter?.status === "SCHEDULED" &&
      deactivateJobAfter?.assignedMembershipId === deactivateMem.id,
  );

  const memberStart = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    memberJob.id,
    syncPayload(memberJob, memberMem.id, [
      { action: "START_JOB", intendedAt: startAt },
    ]),
  );
  const memberAfterStart = await loadNativeAssignedJob(
    prisma,
    memberAccess.access,
    memberJob.id,
  );
  const startedRows = await prisma.timeEntry.findMany({
    where: { jobId: memberJob.id, businessId: businessA.id },
  });
  check(
    "Assigned MEMBER can sync an offline start through the canonical job-time write",
    memberStart.ok === true &&
      memberStart.alreadySynced === false &&
      memberStart.job.status === "IN_PROGRESS" &&
      memberStart.job.runningTime.running === true &&
      memberStart.job.runningTime.startedAt === startAt &&
      startedRows.length === 1 &&
      startedRows[0].status === "RUNNING" &&
      startedRows[0].startedAt.toISOString() === startAt,
  );
  check(
    "Reloaded assigned job shows server time, not a local unsynced overlay",
    memberAfterStart?.status === "IN_PROGRESS" &&
      memberAfterStart.runningTime.running === true &&
      memberAfterStart.runningTime.startedAt === startAt,
  );

  const replay = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    memberJob.id,
    syncPayload(memberJob, memberMem.id, [
      { action: "START_JOB", intendedAt: startAt },
    ]),
  );
  const replayRows = await prisma.timeEntry.findMany({
    where: { jobId: memberJob.id, businessId: businessA.id },
  });
  check(
    "Replaying a committed start succeeds as alreadySynced without a second entry",
    replay.ok === true &&
      replay.alreadySynced === true &&
      replayRows.length === 1 &&
      replayRows[0].startedAt.toISOString() === startAt,
  );

  const stopAt = "2026-10-02T15:30:00.000Z";
  await createRunningEntry({
    businessId: businessA.id,
    membershipId: memberMem.id,
    jobId: stopJob.id,
    startedAt: stopStartedAt,
  });
  const memberStop = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    stopJob.id,
    syncPayload(
      stopJob,
      memberMem.id,
      [{ action: "STOP_JOB_TIME", intendedAt: stopAt }],
      {
        runningTime: {
          running: true,
          startedAt: stopStartedAt.toISOString(),
          endedAt: null,
        },
      },
    ),
  );
  const stoppedRows = await prisma.timeEntry.findMany({
    where: { jobId: stopJob.id, businessId: businessA.id },
  });
  check(
    "Assigned MEMBER can sync an offline stop through the canonical stop write",
    memberStop.ok === true &&
      memberStop.alreadySynced === false &&
      memberStop.job.runningTime.running === false &&
      memberStop.job.runningTime.recorded === true &&
      stoppedRows.length === 1 &&
      stoppedRows[0].status === "READY" &&
      stoppedRows[0].endedAt?.toISOString() === stopAt &&
      memberStop.job.status === "IN_PROGRESS",
  );

  const startStopStart = new Date(Date.parse(startAt) + 10 * 60 * 1000).toISOString();
  const startStopEnd = new Date(Date.parse(startAt) + 20 * 60 * 1000).toISOString();
  const startStop = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    startStopJob.id,
    syncPayload(startStopJob, memberMem.id, [
      { action: "START_JOB", intendedAt: startStopStart },
      { action: "STOP_JOB_TIME", intendedAt: startStopEnd },
    ]),
  );
  const startStopRows = await prisma.timeEntry.findMany({
    where: { jobId: startStopJob.id, businessId: businessA.id },
  });
  check(
    "A start-then-stop draft applies both intents in one sync",
    startStop.ok === true &&
      startStop.alreadySynced === false &&
      startStopRows.length === 1 &&
      startStopRows[0].status === "READY" &&
      startStopRows[0].startedAt.toISOString() === startStopStart &&
      startStopRows[0].endedAt?.toISOString() === startStopEnd,
  );

  const retryStart = new Date(Date.parse(startAt) + 25 * 60 * 1000).toISOString();
  const retryPayload = syncPayload(retryJob, memberMem.id, [
    { action: "START_JOB", intendedAt: retryStart },
  ]);
  const retryFirst = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    retryJob.id,
    retryPayload,
  );
  const retrySecond = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    retryJob.id,
    retryPayload,
  );
  const retryRows = await prisma.timeEntry.findMany({
    where: { jobId: retryJob.id, businessId: businessA.id },
  });
  check(
    "A retried sync after a dropped response is alreadySynced and does not double-write",
    retryFirst.ok === true &&
      retryFirst.alreadySynced === false &&
      retrySecond.ok === true &&
      retrySecond.alreadySynced === true &&
      retryRows.length === 1,
  );

  const deviceAStart = new Date(Date.parse(startAt) + 30 * 60 * 1000).toISOString();
  const deviceBStart = new Date(Date.parse(startAt) + 35 * 60 * 1000).toISOString();
  const conflictBase = syncPayload(conflictJob, memberMem.id, [
    { action: "START_JOB", intendedAt: deviceAStart },
  ]);
  const deviceA = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    conflictJob.id,
    conflictBase,
  );
  const deviceB = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    conflictJob.id,
    {
      expectedFingerprint: conflictBase.expectedFingerprint,
      intents: [{ action: "START_JOB", intendedAt: deviceBStart }],
    },
  );
  const conflictRows = await prisma.timeEntry.findMany({
    where: { jobId: conflictJob.id, businessId: businessA.id },
  });
  check(
    "A second-device start against the same base is a visible stale 409 and does not overwrite",
    deviceA.ok === true &&
      deviceB.ok === false &&
      deviceB.status === 409 &&
      deviceB.error === NATIVE_TIME_CARD_STALE_MESSAGE &&
      conflictRows.length === 1 &&
      conflictRows[0].startedAt.toISOString() === deviceAStart,
  );

  function createTwoPartyBarrier(timeoutMs = 10_000) {
    let releaseBarrier;
    let started = 0;
    let settled = false;
    const barrier = new Promise((resolve, reject) => {
      releaseBarrier = resolve;
      setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Two-party barrier timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    return async function waitForPeer() {
      started += 1;
      if (started === 2) {
        settled = true;
        releaseBarrier();
      }
      await barrier;
    };
  }

  const concurrentA = new Date(Date.parse(startAt) + 40 * 60 * 1000).toISOString();
  const concurrentB = new Date(Date.parse(startAt) + 41 * 60 * 1000).toISOString();
  const concurrentExpected = syncPayload(concurrentJob, memberMem.id, [
    { action: "START_JOB", intendedAt: concurrentA },
  ]).expectedFingerprint;
  const waitForPeer = createTwoPartyBarrier();
  const [left, right] = await Promise.all([
    syncNativeAssignedTimeCardDraft(
      prisma,
      memberAccess.access,
      concurrentJob.id,
      {
        expectedFingerprint: concurrentExpected,
        intents: [{ action: "START_JOB", intendedAt: concurrentA }],
      },
      { afterInitialRead: waitForPeer },
    ),
    syncNativeAssignedTimeCardDraft(
      prisma,
      memberAccess.access,
      concurrentJob.id,
      {
        expectedFingerprint: concurrentExpected,
        intents: [{ action: "START_JOB", intendedAt: concurrentB }],
      },
      { afterInitialRead: waitForPeer },
    ),
  ]);
  const concurrentRows = await prisma.timeEntry.findMany({
    where: { jobId: concurrentJob.id, businessId: businessA.id },
  });
  const winners = [left, right].filter((row) => row.ok === true && row.alreadySynced === false);
  const staleLosers = [left, right].filter(
    (row) => row.ok === false && row.status === 409 && row.error === NATIVE_TIME_CARD_STALE_MESSAGE,
  );
  check(
    "Two concurrent device syncs on the same base leave exactly one winner and one stale 409",
    winners.length === 1 && staleLosers.length === 1 && concurrentRows.length === 1,
  );

  const unconfirmed = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    unconfirmedJob.id,
    syncPayload(unconfirmedJob, memberMem.id, [
      { action: "START_JOB", intendedAt: "2026-10-02T16:30:00.000Z" },
    ]),
  );
  check(
    "An unconfirmed appointment refuses an offline start",
    unconfirmed.ok === false &&
      unconfirmed.status === 409 &&
      unconfirmed.error === CUSTOMER_HAS_NOT_CONFIRMED_APPOINTMENT,
  );

  const race = await syncNativeAssignedTimeCardDraft(
    prisma,
    memberAccess.access,
    raceJob.id,
    syncPayload(raceJob, memberMem.id, [
      { action: "START_JOB", intendedAt: "2026-10-02T16:45:00.000Z" },
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
  const raceRows = await prisma.timeEntry.findMany({
    where: { jobId: raceJob.id, businessId: businessA.id },
  });
  const raceAfter = await prisma.job.findFirst({
    where: { id: raceJob.id },
    select: { assignedMembershipId: true, status: true },
  });
  check(
    "Assignment change after the initial read refuses the time-card sync",
    race.ok === false && race.status === 404 && race.error === NATIVE_JOB_NOT_AVAILABLE,
  );
  check(
    "Reassigned Job after the initial read leaves no time write",
    raceRows.length === 0 &&
      raceAfter?.assignedMembershipId === otherMem.id &&
      raceAfter?.status === "SCHEDULED",
  );

  const saturdayCivil = civil("2026-09-26", "23:00", "America/Los_Angeles");
  const sundayCivil = civil("2026-09-27", "00:30", "America/Los_Angeles");
  const laSaturdayWeek = weekRange(saturdayCivil, "America/Los_Angeles");
  const laSundayWeek = weekRange(sundayCivil, "America/Los_Angeles");
  const nySaturdayWeek = weekRange(saturdayCivil, "America/New_York");
  check(
    "Saturday 23:00 America/Los_Angeles is stored in UTC in the prior week, not the New York week",
    saturdayCivil.toISOString() === "2026-09-27T06:00:00.000Z" &&
      sundayCivil.toISOString() === "2026-09-27T07:30:00.000Z" &&
      laSaturdayWeek.start.toISOString() === "2026-09-20T07:00:00.000Z" &&
      laSundayWeek.start.toISOString() === "2026-09-27T07:00:00.000Z" &&
      nySaturdayWeek.start.getTime() !== laSaturdayWeek.start.getTime(),
  );
  check(
    "A Sunday 00:30 America/Los_Angeles instant lands in the next open week",
    laSundayWeek.start.getTime() > laSaturdayWeek.start.getTime() &&
      sundayCivil.getTime() >= laSundayWeek.start.getTime() &&
      sundayCivil.getTime() < laSundayWeek.end.getTime(),
  );

  const laNow = new Date();
  const currentLaWeek = weekRange(laNow, "America/Los_Angeles");
  await createReadyEntry({
    businessId: laBusiness.id,
    membershipId: laMem.id,
    startedAt: new Date(laNow.getTime() - 2 * 60 * 60 * 1000),
    endedAt: new Date(laNow.getTime() - 60 * 60 * 1000),
  });
  await approveTimesheetWeek(prisma, ownerLa, {
    membershipId: laMem.id,
    weekStartedAt: currentLaWeek.start,
    timeZone: "America/Los_Angeles",
  });
  const approvedRecent = new Date(laNow.getTime() - 60_000).toISOString();
  const approvedSync = await syncNativeAssignedTimeCardDraft(
    prisma,
    laAccess.access,
    approvedJob.id,
    syncPayload(approvedJob, laMem.id, [
      { action: "START_JOB", intendedAt: approvedRecent },
    ]),
  );
  const approvedRows = await prisma.timeEntry.findMany({
    where: { jobId: approvedJob.id, businessId: laBusiness.id },
  });
  check(
    "A recent LA tap in an approved week is refused even if the device is in New York",
    approvedSync.ok === false &&
      approvedSync.status === 409 &&
      String(approvedSync.error).toLowerCase().includes("approved") &&
      approvedRows.length === 0,
  );

  const leftoverB = await prisma.timeEntry.findMany({ where: { businessId: businessB.id } });
  check(
    "Failed cross-tenant syncs left no Beta time entries",
    leftoverB.length === 0 && betaAccess.ok === true,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - live native time-card offline sync", error);
} finally {
  await prisma.$disconnect();
  await prismaRace.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

console.log(
  failures === 0
    ? "\nNative field time-card offline check passed: local drafts, explicit sync, conflicts, retries, timezone, and storage held."
    : `\n${failures} native field time-card offline check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
