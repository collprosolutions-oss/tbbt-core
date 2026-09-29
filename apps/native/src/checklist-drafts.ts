export type ChecklistDraftStorage = {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type ChecklistDraftScope = {
  businessId: string;
  membershipId: string;
  jobId: string;
};

export type ChecklistExpectedItem = {
  key: string;
  checked: boolean;
};

export type ChecklistDraftChange = {
  itemKey: string;
  checked: boolean;
};

export type ChecklistDraft = {
  businessId: string;
  membershipId: string;
  jobId: string;
  expectedFingerprint: string;
  expectedChecklist: ChecklistExpectedItem[];
  items: ChecklistDraftChange[];
  savedAt: string;
};

export type ChecklistDisplayItem = {
  key: string;
  title: string;
  required: boolean;
  checked: boolean;
};

/** expo-secure-store accepts only this key shape in get/set/delete. */
export const SECURE_STORE_KEY_PATTERN = /^[\w.-]+$/;
export const SECURE_STORE_VALUE_MAX_BYTES = 2048;
export const CHECKLIST_DRAFT_INDEX_KEY = "tbbt.native.checklist.drafts";
export const CHECKLIST_DRAFT_STORAGE_ERROR =
  "Checklist changes could not be saved on this phone.";

const DRAFT_KEY_PREFIX = "tbbt.native.checklist.draft";

export class ChecklistDraftStorageError extends Error {
  constructor(message = CHECKLIST_DRAFT_STORAGE_ERROR) {
    super(message);
    this.name = "ChecklistDraftStorageError";
  }
}

function storageToken(value: string) {
  return value.replace(/[^\w.-]/g, "_");
}

export function checklistDraftStorageKey(scope: ChecklistDraftScope) {
  const key = [
    DRAFT_KEY_PREFIX,
    storageToken(scope.businessId),
    storageToken(scope.membershipId),
    storageToken(scope.jobId),
  ].join(".");
  if (!SECURE_STORE_KEY_PATTERN.test(key)) {
    throw new ChecklistDraftStorageError();
  }
  return key;
}

export function isSecureStoreKey(key: string) {
  return SECURE_STORE_KEY_PATTERN.test(key);
}

export function checklistStateFingerprint(
  items: Array<{ key: string; checked: boolean }>,
): string {
  const canonical = items
    .map((item) => `${item.key.trim()}:${item.checked ? "1" : "0"}`)
    .sort()
    .join("|");
  let hash = 2166136261;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createMemoryChecklistDraftStorage(
  initial?: Map<string, string>,
): ChecklistDraftStorage {
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

export function expectedChecklistFromItems(
  items: Array<{ key: string; checked: boolean }>,
): ChecklistExpectedItem[] {
  return items.map((item) => ({ key: item.key, checked: item.checked }));
}

export function overlayChecklistDraft<T extends { key: string; checked: boolean }>(
  items: T[],
  draft: ChecklistDraft | null,
): T[] {
  if (!draft || draft.items.length === 0) return items;
  const pending = new Map(draft.items.map((item) => [item.itemKey, item.checked]));
  return items.map((item) =>
    pending.has(item.key) ? { ...item, checked: pending.get(item.key) === true } : item,
  );
}

function storedByteLength(value: string) {
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

export function recordLocalChecklistChange(input: {
  scope: ChecklistDraftScope;
  serverItems: Array<{ key: string; checked: boolean }>;
  draft: ChecklistDraft | null;
  itemKey: string;
  checked: boolean;
  now?: Date;
}): ChecklistDraft | null {
  if (!input.serverItems.some((item) => item.key === input.itemKey)) {
    return input.draft;
  }
  const serverFingerprint = checklistStateFingerprint(input.serverItems);
  const expectedChecklist =
    input.draft &&
    input.draft.expectedChecklist.length > 0 &&
    input.draft.expectedFingerprint === serverFingerprint
      ? input.draft.expectedChecklist
      : input.draft && input.draft.expectedChecklist.length > 0
        ? input.draft.expectedChecklist
        : expectedChecklistFromItems(input.serverItems);
  const overlay = overlayChecklistDraft(input.serverItems, input.draft).map((item) =>
    item.key === input.itemKey ? { ...item, checked: input.checked } : item,
  );
  const items = overlay
    .filter((item) => {
      const expected = expectedChecklist.find((row) => row.key === item.key);
      return expected ? expected.checked !== item.checked : false;
    })
    .map((item) => ({ itemKey: item.key, checked: item.checked }));
  if (items.length === 0) return null;
  return {
    businessId: input.scope.businessId,
    membershipId: input.scope.membershipId,
    jobId: input.scope.jobId,
    expectedFingerprint: checklistStateFingerprint(expectedChecklist),
    expectedChecklist,
    items,
    savedAt: (input.now ?? new Date()).toISOString(),
  };
}

type StoredChecklistDraft = {
  businessId: string;
  membershipId: string;
  jobId: string;
  expectedFingerprint: string;
  expectedChecked: Record<string, boolean>;
  items: ChecklistDraftChange[];
  savedAt: string;
};

function toStoredDraft(draft: ChecklistDraft): StoredChecklistDraft {
  const expectedChecked: Record<string, boolean> = {};
  for (const item of draft.expectedChecklist) {
    expectedChecked[item.key] = item.checked;
  }
  return {
    businessId: draft.businessId,
    membershipId: draft.membershipId,
    jobId: draft.jobId,
    expectedFingerprint: draft.expectedFingerprint,
    expectedChecked,
    items: draft.items,
    savedAt: draft.savedAt,
  };
}

function fromStoredDraft(
  stored: StoredChecklistDraft,
  scope: ChecklistDraftScope,
): ChecklistDraft | null {
  const expectedChecklist = Object.entries(stored.expectedChecked)
    .map(([key, checked]) => {
      const trimmed = key.trim();
      return trimmed && typeof checked === "boolean" ? { key: trimmed, checked } : null;
    })
    .filter((row): row is ChecklistExpectedItem => row !== null);
  const items = stored.items
    .map((row) => {
      if (!row || typeof row.itemKey !== "string" || typeof row.checked !== "boolean") {
        return null;
      }
      const itemKey = row.itemKey.trim();
      return itemKey ? { itemKey, checked: row.checked } : null;
    })
    .filter((row): row is ChecklistDraftChange => row !== null);
  if (expectedChecklist.length === 0 || items.length === 0) return null;
  return {
    businessId: scope.businessId,
    membershipId: scope.membershipId,
    jobId: scope.jobId,
    expectedFingerprint: stored.expectedFingerprint,
    expectedChecklist,
    items,
    savedAt: stored.savedAt,
  };
}

function parseDraft(raw: string | null, scope: ChecklistDraftScope): ChecklistDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChecklistDraft>;
    if (
      !parsed ||
      parsed.businessId !== scope.businessId ||
      parsed.membershipId !== scope.membershipId ||
      parsed.jobId !== scope.jobId ||
      typeof parsed.expectedFingerprint !== "string" ||
      !parsed.expectedChecked ||
      typeof parsed.expectedChecked !== "object" ||
      !Array.isArray(parsed.items) ||
      typeof parsed.savedAt !== "string"
    ) {
      return null;
    }
    return fromStoredDraft(
      {
        businessId: parsed.businessId,
        membershipId: parsed.membershipId,
        jobId: parsed.jobId,
        expectedFingerprint: parsed.expectedFingerprint,
        expectedChecked: parsed.expectedChecked,
        items: parsed.items,
        savedAt: parsed.savedAt,
      },
      scope,
    );
  } catch {
    return null;
  }
}

async function readDraftIndex(storage: ChecklistDraftStorage): Promise<string[]> {
  const raw = await storage.read(CHECKLIST_DRAFT_INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && isSecureStoreKey(key));
  } catch {
    return [];
  }
}

async function writeDraftIndex(storage: ChecklistDraftStorage, keys: string[]) {
  const unique = [...new Set(keys)].filter(isSecureStoreKey);
  if (unique.length === 0) {
    await storage.remove(CHECKLIST_DRAFT_INDEX_KEY);
    return;
  }
  await storage.write(CHECKLIST_DRAFT_INDEX_KEY, JSON.stringify(unique));
}

async function rememberDraftKey(storage: ChecklistDraftStorage, key: string) {
  const keys = await readDraftIndex(storage);
  if (!keys.includes(key)) {
    keys.push(key);
    await writeDraftIndex(storage, keys);
  }
}

async function forgetDraftKey(storage: ChecklistDraftStorage, key: string) {
  const keys = await readDraftIndex(storage);
  await writeDraftIndex(
    storage,
    keys.filter((item) => item !== key),
  );
}

export async function loadChecklistDraft(
  storage: ChecklistDraftStorage,
  scope: ChecklistDraftScope,
): Promise<ChecklistDraft | null> {
  const key = checklistDraftStorageKey(scope);
  try {
    return parseDraft(await storage.read(key), scope);
  } catch (error) {
    throw error instanceof ChecklistDraftStorageError
      ? error
      : new ChecklistDraftStorageError();
  }
}

export async function saveChecklistDraft(
  storage: ChecklistDraftStorage,
  draft: ChecklistDraft | null,
): Promise<void> {
  if (!draft) return;
  const scope = {
    businessId: draft.businessId,
    membershipId: draft.membershipId,
    jobId: draft.jobId,
  };
  const key = checklistDraftStorageKey(scope);
  const payload = JSON.stringify(toStoredDraft(draft));
  if (storedByteLength(payload) > SECURE_STORE_VALUE_MAX_BYTES) {
    throw new ChecklistDraftStorageError();
  }
  try {
    await storage.write(key, payload);
    await rememberDraftKey(storage, key);
  } catch (error) {
    throw error instanceof ChecklistDraftStorageError
      ? error
      : new ChecklistDraftStorageError();
  }
}

export async function clearChecklistDraft(
  storage: ChecklistDraftStorage,
  scope: ChecklistDraftScope,
): Promise<void> {
  const key = checklistDraftStorageKey(scope);
  try {
    await storage.remove(key);
    await forgetDraftKey(storage, key);
  } catch (error) {
    throw error instanceof ChecklistDraftStorageError
      ? error
      : new ChecklistDraftStorageError();
  }
}

export async function clearAllChecklistDrafts(storage: ChecklistDraftStorage): Promise<void> {
  const keys = await readDraftIndex(storage);
  for (const key of keys) {
    try {
      await storage.remove(key);
    } catch {
      // Keep clearing the rest of the index.
    }
  }
  await writeDraftIndex(storage, []);
}

export async function persistLocalChecklistChange(
  storage: ChecklistDraftStorage,
  input: {
    scope: ChecklistDraftScope;
    serverItems: Array<{ key: string; checked: boolean }>;
    itemKey: string;
    checked: boolean;
    now?: Date;
  },
): Promise<ChecklistDraft | null> {
  const current = await loadChecklistDraft(storage, input.scope);
  const next = recordLocalChecklistChange({
    ...input,
    draft: current,
  });
  if (!next) {
    await clearChecklistDraft(storage, input.scope);
    return null;
  }
  await saveChecklistDraft(storage, next);
  return next;
}

export function listIndexedChecklistDraftKeys(keysJson: string | null): string[] {
  if (!keysJson) return [];
  try {
    const parsed = JSON.parse(keysJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string" && isSecureStoreKey(key));
  } catch {
    return [];
  }
}
