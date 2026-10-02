export type TimeCardDraftStorage = {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type TimeCardDraftScope = {
  businessId: string;
  membershipId: string;
  jobId: string;
};

export type TimeCardDraftAccount = {
  businessId: string;
  membershipId: string;
};

export const TIME_CARD_DRAFT_ACTIONS = [
  "START_JOB",
  "STOP_JOB_TIME",
  "START_TRAVEL",
  "STOP_TRAVEL",
  "START_PICKUP",
  "STOP_PICKUP",
] as const;

export type TimeCardDraftAction = (typeof TIME_CARD_DRAFT_ACTIONS)[number];

export type TimeCardDraftIntent = {
  action: TimeCardDraftAction;
  intendedAt: string;
};

export type TimeCardClockState = {
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
};

export type TimeCardClockSnapshot = {
  jobStatus: string;
  assignmentId: string;
  clocks: {
    JOB: TimeCardClockState;
    TRAVEL: TimeCardClockState;
    MATERIAL_PICKUP: TimeCardClockState;
  };
};

export type TimeCardDraft = {
  businessId: string;
  membershipId: string;
  jobId: string;
  expectedFingerprint: string;
  intents: TimeCardDraftIntent[];
  savedAt: string;
};

/** expo-secure-store accepts only this key shape in get/set/delete. */
export const SECURE_STORE_KEY_PATTERN = /^[\w.-]+$/;
export const SECURE_STORE_VALUE_MAX_BYTES = 2048;
export const TIME_CARD_DRAFT_INDEX_KEY = "tbbt.native.timecard.drafts";
export const TIME_CARD_DRAFT_ACCOUNT_KEY = "tbbt.native.timecard.account";
/** ~108 bytes per cuid-scoped key; 16 keys stay under 2048. */
export const TIME_CARD_DRAFT_INDEX_MAX_KEYS = 16;
export const TIME_CARD_DRAFT_MAX_INTENTS = 4;
export const TIME_CARD_DRAFT_STORAGE_ERROR =
  "Time-card changes could not be saved on this phone.";
export const TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES = "Sync before more changes";
export const TIME_CARD_DRAFT_INDEX_FULL_MESSAGE =
  "Sync or discard another job's time before saving more changes.";
export const TIME_CARD_DRAFT_DUPLICATE_TAP_MESSAGE =
  "That start or stop is already saved on this phone.";

const DRAFT_KEY_PREFIX = "tbbt.native.timecard.draft";

export class TimeCardDraftStorageError extends Error {
  constructor(message = TIME_CARD_DRAFT_STORAGE_ERROR) {
    super(message);
    this.name = "TimeCardDraftStorageError";
  }
}

function storageToken(value: string) {
  return value.replace(/[^\w.-]/g, "_");
}

export function timeCardDraftStorageKey(scope: TimeCardDraftScope) {
  const key = [
    DRAFT_KEY_PREFIX,
    storageToken(scope.businessId),
    storageToken(scope.membershipId),
    storageToken(scope.jobId),
  ].join(".");
  if (!SECURE_STORE_KEY_PATTERN.test(key)) {
    throw new TimeCardDraftStorageError();
  }
  return key;
}

export function isSecureStoreKey(key: string) {
  return SECURE_STORE_KEY_PATTERN.test(key);
}

export function isTimeCardDraftAction(value: string): value is TimeCardDraftAction {
  return (TIME_CARD_DRAFT_ACTIONS as readonly string[]).includes(value);
}

export function idleTimeCardClockState(): TimeCardClockState {
  return { running: false, startedAt: null, endedAt: null };
}

export function emptyTimeCardClockSnapshot(
  jobStatus: string,
  assignmentId: string,
): TimeCardClockSnapshot {
  return {
    jobStatus,
    assignmentId,
    clocks: {
      JOB: idleTimeCardClockState(),
      TRAVEL: idleTimeCardClockState(),
      MATERIAL_PICKUP: idleTimeCardClockState(),
    },
  };
}

export function clockStateFromRunningTime(input: {
  running?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
} | null | undefined): TimeCardClockState {
  if (!input) return idleTimeCardClockState();
  return {
    running: input.running === true,
    startedAt: typeof input.startedAt === "string" && input.startedAt.trim() ? input.startedAt : null,
    endedAt: typeof input.endedAt === "string" && input.endedAt.trim() ? input.endedAt : null,
  };
}

export function timeCardSnapshotFromJob(input: {
  jobStatus: string;
  assignmentId: string;
  runningTime?: { running?: boolean; startedAt?: string | null; endedAt?: string | null } | null;
  travelTime?: { running?: boolean; startedAt?: string | null; endedAt?: string | null } | null;
  pickupTime?: { running?: boolean; startedAt?: string | null; endedAt?: string | null } | null;
}): TimeCardClockSnapshot {
  return {
    jobStatus: input.jobStatus,
    assignmentId: input.assignmentId,
    clocks: {
      JOB: clockStateFromRunningTime(input.runningTime),
      TRAVEL: clockStateFromRunningTime(input.travelTime),
      MATERIAL_PICKUP: clockStateFromRunningTime(input.pickupTime),
    },
  };
}

function clockCanonical(state: TimeCardClockState) {
  return `${state.running ? "1" : "0"}:${state.startedAt ?? ""}:${state.endedAt ?? ""}`;
}

export function timeCardStateCanonical(snapshot: TimeCardClockSnapshot) {
  return [
    `status:${snapshot.jobStatus.trim()}`,
    `assign:${snapshot.assignmentId.trim()}`,
    `JOB:${clockCanonical(snapshot.clocks.JOB)}`,
    `TRAVEL:${clockCanonical(snapshot.clocks.TRAVEL)}`,
    `PICKUP:${clockCanonical(snapshot.clocks.MATERIAL_PICKUP)}`,
  ].join("|");
}

/** FNV-1a of the canonical clock snapshot. Must stay identical to the server copy. */
export function timeCardStateFingerprint(snapshot: TimeCardClockSnapshot): string {
  const canonical = timeCardStateCanonical(snapshot);
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createMemoryTimeCardDraftStorage(
  initial?: Map<string, string>,
): TimeCardDraftStorage {
  const data = initial ?? new Map<string, string>();
  return {
    async read(key) {
      return data.has(key) ? (data.get(key) ?? null) : null;
    },
    async write(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

export function storedByteLength(value: string) {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function timeCardDraftActionLabel(action: TimeCardDraftAction) {
  switch (action) {
    case "START_JOB":
      return "Unsynced start";
    case "STOP_JOB_TIME":
      return "Unsynced stop";
    case "START_TRAVEL":
      return "Unsynced travel start";
    case "STOP_TRAVEL":
      return "Unsynced travel stop";
    case "START_PICKUP":
      return "Unsynced material pickup start";
    case "STOP_PICKUP":
      return "Unsynced material pickup stop";
  }
}

export function draftHasTimeCardAction(draft: TimeCardDraft | null, action: TimeCardDraftAction) {
  return Boolean(draft?.intents.some((intent) => intent.action === action));
}

function clockTypeForAction(
  action: TimeCardDraftAction,
): keyof TimeCardClockSnapshot["clocks"] {
  if (action === "START_JOB" || action === "STOP_JOB_TIME") return "JOB";
  if (action === "START_TRAVEL" || action === "STOP_TRAVEL") return "TRAVEL";
  return "MATERIAL_PICKUP";
}

function isStartAction(action: TimeCardDraftAction) {
  return action === "START_JOB" || action === "START_TRAVEL" || action === "START_PICKUP";
}

export function applyTimeCardIntentsToSnapshot(
  snapshot: TimeCardClockSnapshot,
  intents: TimeCardDraftIntent[],
): TimeCardClockSnapshot {
  const next: TimeCardClockSnapshot = {
    jobStatus: snapshot.jobStatus,
    assignmentId: snapshot.assignmentId,
    clocks: {
      JOB: { ...snapshot.clocks.JOB },
      TRAVEL: { ...snapshot.clocks.TRAVEL },
      MATERIAL_PICKUP: { ...snapshot.clocks.MATERIAL_PICKUP },
    },
  };
  for (const intent of intents) {
    const clock = clockTypeForAction(intent.action);
    if (isStartAction(intent.action)) {
      for (const key of ["JOB", "TRAVEL", "MATERIAL_PICKUP"] as const) {
        if (next.clocks[key].running) {
          next.clocks[key] = {
            running: false,
            startedAt: next.clocks[key].startedAt,
            endedAt: intent.intendedAt,
          };
        }
      }
      next.clocks[clock] = {
        running: true,
        startedAt: intent.intendedAt,
        endedAt: null,
      };
      if (intent.action === "START_JOB" && next.jobStatus !== "COMPLETED") {
        next.jobStatus = "IN_PROGRESS";
      }
    } else {
      next.clocks[clock] = {
        running: false,
        startedAt: next.clocks[clock].startedAt,
        endedAt: intent.intendedAt,
      };
    }
  }
  return next;
}

export function recordLocalTimeCardIntent(input: {
  scope: TimeCardDraftScope;
  snapshot: TimeCardClockSnapshot;
  draft: TimeCardDraft | null;
  action: TimeCardDraftAction;
  now?: Date;
}): TimeCardDraft {
  if (input.draft && draftHasTimeCardAction(input.draft, input.action)) {
    throw new TimeCardDraftStorageError(TIME_CARD_DRAFT_DUPLICATE_TAP_MESSAGE);
  }
  const intendedAt = (input.now ?? new Date()).toISOString();
  const previous = input.draft?.intents[input.draft.intents.length - 1];
  if (previous && Date.parse(intendedAt) <= Date.parse(previous.intendedAt)) {
    throw new TimeCardDraftStorageError(TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES);
  }
  const intents = [...(input.draft?.intents ?? []), { action: input.action, intendedAt }];
  if (intents.length > TIME_CARD_DRAFT_MAX_INTENTS) {
    throw new TimeCardDraftStorageError(TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES);
  }
  return {
    businessId: input.scope.businessId,
    membershipId: input.scope.membershipId,
    jobId: input.scope.jobId,
    expectedFingerprint:
      input.draft?.expectedFingerprint ?? timeCardStateFingerprint(input.snapshot),
    intents,
    savedAt: intendedAt,
  };
}

type StoredTimeCardDraft = {
  businessId: string;
  membershipId: string;
  jobId: string;
  expectedFingerprint: string;
  intents: TimeCardDraftIntent[];
  savedAt: string;
};

function toStoredDraft(draft: TimeCardDraft): StoredTimeCardDraft {
  return {
    businessId: draft.businessId,
    membershipId: draft.membershipId,
    jobId: draft.jobId,
    expectedFingerprint: draft.expectedFingerprint,
    intents: draft.intents,
    savedAt: draft.savedAt,
  };
}

function parseIntent(row: unknown): TimeCardDraftIntent | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const payload = row as Partial<TimeCardDraftIntent>;
  if (typeof payload.action !== "string" || !isTimeCardDraftAction(payload.action)) {
    return null;
  }
  if (typeof payload.intendedAt !== "string") return null;
  const intendedAt = payload.intendedAt.trim();
  if (!intendedAt || Number.isNaN(Date.parse(intendedAt))) return null;
  return { action: payload.action, intendedAt };
}

function parseDraft(raw: string | null, scope: TimeCardDraftScope): TimeCardDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTimeCardDraft>;
    if (
      !parsed ||
      parsed.businessId !== scope.businessId ||
      parsed.membershipId !== scope.membershipId ||
      parsed.jobId !== scope.jobId ||
      typeof parsed.expectedFingerprint !== "string" ||
      !Array.isArray(parsed.intents) ||
      typeof parsed.savedAt !== "string"
    ) {
      return null;
    }
    const intents = parsed.intents
      .map(parseIntent)
      .filter((row): row is TimeCardDraftIntent => row !== null);
    if (intents.length === 0) return null;
    return {
      businessId: scope.businessId,
      membershipId: scope.membershipId,
      jobId: scope.jobId,
      expectedFingerprint: parsed.expectedFingerprint,
      intents,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

async function readDraftIndex(storage: TimeCardDraftStorage): Promise<string[]> {
  const raw = await storage.read(TIME_CARD_DRAFT_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && isSecureStoreKey(key));
  } catch {
    return [];
  }
}

async function writeDraftIndex(storage: TimeCardDraftStorage, keys: string[]) {
  const unique = [...new Set(keys)].filter(isSecureStoreKey);
  if (unique.length === 0) {
    await storage.remove(TIME_CARD_DRAFT_INDEX_KEY);
    return;
  }
  const encoded = JSON.stringify(unique);
  if (storedByteLength(encoded) > SECURE_STORE_VALUE_MAX_BYTES) {
    throw new TimeCardDraftStorageError(TIME_CARD_DRAFT_INDEX_FULL_MESSAGE);
  }
  await storage.write(TIME_CARD_DRAFT_INDEX_KEY, encoded);
}

async function rememberDraftKey(storage: TimeCardDraftStorage, key: string) {
  const keys = await readDraftIndex(storage);
  if (keys.includes(key)) return;
  if (keys.length >= TIME_CARD_DRAFT_INDEX_MAX_KEYS) {
    throw new TimeCardDraftStorageError(TIME_CARD_DRAFT_INDEX_FULL_MESSAGE);
  }
  await writeDraftIndex(storage, [...keys, key]);
}

async function forgetDraftKey(storage: TimeCardDraftStorage, key: string) {
  const keys = await readDraftIndex(storage);
  await writeDraftIndex(
    storage,
    keys.filter((item) => item !== key),
  );
}

export async function loadTimeCardDraft(
  storage: TimeCardDraftStorage,
  scope: TimeCardDraftScope,
): Promise<TimeCardDraft | null> {
  const key = timeCardDraftStorageKey(scope);
  try {
    return parseDraft(await storage.read(key), scope);
  } catch (error) {
    throw error instanceof TimeCardDraftStorageError
      ? error
      : new TimeCardDraftStorageError();
  }
}

export async function saveTimeCardDraft(
  storage: TimeCardDraftStorage,
  draft: TimeCardDraft | null,
): Promise<void> {
  if (!draft) return;
  const scope = {
    businessId: draft.businessId,
    membershipId: draft.membershipId,
    jobId: draft.jobId,
  };
  const key = timeCardDraftStorageKey(scope);
  const payload = JSON.stringify(toStoredDraft(draft));
  if (storedByteLength(payload) > SECURE_STORE_VALUE_MAX_BYTES) {
    throw new TimeCardDraftStorageError(TIME_CARD_DRAFT_SYNC_BEFORE_MORE_CHANGES);
  }
  try {
    await rememberDraftKey(storage, key);
    await storage.write(key, payload);
  } catch (error) {
    throw error instanceof TimeCardDraftStorageError
      ? error
      : new TimeCardDraftStorageError();
  }
}

export async function clearTimeCardDraft(
  storage: TimeCardDraftStorage,
  scope: TimeCardDraftScope,
): Promise<void> {
  const key = timeCardDraftStorageKey(scope);
  try {
    await storage.remove(key);
    await forgetDraftKey(storage, key);
  } catch (error) {
    throw error instanceof TimeCardDraftStorageError
      ? error
      : new TimeCardDraftStorageError();
  }
}

export async function clearAllTimeCardDrafts(storage: TimeCardDraftStorage): Promise<void> {
  try {
    const keys = await readDraftIndex(storage);
    for (const key of keys) {
      try {
        await storage.remove(key);
      } catch {
        // Keep clearing the rest of the index.
      }
    }
    try {
      await storage.remove(TIME_CARD_DRAFT_INDEX_KEY);
    } catch {
      // Index removal is best-effort so sign-out always finishes.
    }
  } catch {
    // Sign-out and account-switch must always finish.
  }
}

export async function readTimeCardDraftAccount(
  storage: TimeCardDraftStorage,
): Promise<TimeCardDraftAccount | null> {
  try {
    const raw = await storage.read(TIME_CARD_DRAFT_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TimeCardDraftAccount>;
    if (
      !parsed ||
      typeof parsed.businessId !== "string" ||
      typeof parsed.membershipId !== "string" ||
      !parsed.businessId.trim() ||
      !parsed.membershipId.trim()
    ) {
      return null;
    }
    return {
      businessId: parsed.businessId,
      membershipId: parsed.membershipId,
    };
  } catch {
    return null;
  }
}

export async function rememberTimeCardDraftAccount(
  storage: TimeCardDraftStorage,
  account: TimeCardDraftAccount,
): Promise<void> {
  const payload = JSON.stringify({
    businessId: account.businessId,
    membershipId: account.membershipId,
  });
  if (storedByteLength(payload) > SECURE_STORE_VALUE_MAX_BYTES) return;
  await storage.write(TIME_CARD_DRAFT_ACCOUNT_KEY, payload);
}

export async function applyTimeCardDraftAccount(
  storage: TimeCardDraftStorage,
  account: TimeCardDraftAccount,
): Promise<void> {
  try {
    const previous = await readTimeCardDraftAccount(storage);
    if (
      previous &&
      (previous.businessId !== account.businessId ||
        previous.membershipId !== account.membershipId)
    ) {
      await clearAllTimeCardDrafts(storage);
    }
    await rememberTimeCardDraftAccount(storage, account);
  } catch {
    // Sign-in must always finish.
  }
}

export async function persistLocalTimeCardIntent(
  storage: TimeCardDraftStorage,
  input: {
    scope: TimeCardDraftScope;
    snapshot: TimeCardClockSnapshot;
    action: TimeCardDraftAction;
    now?: Date;
  },
): Promise<TimeCardDraft> {
  const current = await loadTimeCardDraft(storage, input.scope);
  const next = recordLocalTimeCardIntent({
    ...input,
    draft: current,
  });
  await saveTimeCardDraft(storage, next);
  return next;
}
