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

const DRAFT_KEY_PREFIX = "tbbt.native.checklist.draft";

export function checklistDraftStorageKey(scope: ChecklistDraftScope) {
  return `${DRAFT_KEY_PREFIX}:${scope.businessId}:${scope.membershipId}:${scope.jobId}`;
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
  const expectedChecklist =
    input.draft?.expectedChecklist ?? expectedChecklistFromItems(input.serverItems);
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
    expectedChecklist,
    items,
    savedAt: (input.now ?? new Date()).toISOString(),
  };
}

function parseDraft(raw: string | null, scope: ChecklistDraftScope): ChecklistDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChecklistDraft>;
    if (
      !parsed ||
      parsed.businessId !== scope.businessId ||
      parsed.membershipId !== scope.membershipId ||
      parsed.jobId !== scope.jobId ||
      !Array.isArray(parsed.expectedChecklist) ||
      !Array.isArray(parsed.items) ||
      typeof parsed.savedAt !== "string"
    ) {
      return null;
    }
    const expectedChecklist = parsed.expectedChecklist
      .map((row) => {
        if (!row || typeof row.key !== "string" || typeof row.checked !== "boolean") return null;
        const key = row.key.trim();
        return key ? { key, checked: row.checked } : null;
      })
      .filter((row): row is ChecklistExpectedItem => row !== null);
    const items = parsed.items
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
      expectedChecklist,
      items,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export async function loadChecklistDraft(
  storage: ChecklistDraftStorage,
  scope: ChecklistDraftScope,
): Promise<ChecklistDraft | null> {
  return parseDraft(await storage.read(checklistDraftStorageKey(scope)), scope);
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
  await storage.write(checklistDraftStorageKey(scope), JSON.stringify(draft));
}

export async function clearChecklistDraft(
  storage: ChecklistDraftStorage,
  scope: ChecklistDraftScope,
): Promise<void> {
  await storage.remove(checklistDraftStorageKey(scope));
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
