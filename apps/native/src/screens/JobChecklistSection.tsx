import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  isApiError,
  loadNativeJob,
  NATIVE_CHECKLIST_OFFLINE_MESSAGE,
  syncNativeJobChecklistDraft,
} from "../api";
import { secureChecklistDraftStorage } from "../checklist-draft-storage";
import {
  CHECKLIST_DRAFT_STORAGE_ERROR,
  ChecklistDraftStorageError,
  clearChecklistDraft,
  loadChecklistDraft,
  overlayChecklistDraft,
  persistLocalChecklistChange,
  type ChecklistDraft,
  type ChecklistDraftStorage,
  type ChecklistDisplayItem,
} from "../checklist-drafts";
import type { NativeJobChecklistItem, NativeJobDetail, NativeWorkspace } from "../types";

export const NATIVE_CHECKLIST_CLOSED_NOTICE =
  "This job's checklist can no longer be updated.";

function assignedChecklist(job: NativeJobDetail): {
  procedureTitle: string | null;
  items: NativeJobChecklistItem[];
} | null {
  if (job.checklist && job.checklist.items.length > 0) {
    return job.checklist;
  }
  if (job.visit && job.visit.checklist.length > 0) {
    return {
      procedureTitle: job.visit.procedureTitle,
      items: job.visit.checklist,
    };
  }
  return null;
}

function jobChecklistClosed(job: NativeJobDetail) {
  if (job.status === "COMPLETED" || job.status === "CANCELED" || job.status === "CANCELLED") {
    return true;
  }
  return Boolean(job.visit && job.visit.outcomeStatus !== "NONE");
}

export function JobChecklistSection({
  token,
  job,
  workspace,
  onJobUpdated,
  onUnsyncedChange,
  storage = secureChecklistDraftStorage,
}: {
  token: string;
  job: NativeJobDetail;
  workspace: NativeWorkspace;
  onJobUpdated: (job: NativeJobDetail) => void;
  onUnsyncedChange?: (unsynced: boolean) => void;
  storage?: ChecklistDraftStorage;
}) {
  const source = assignedChecklist(job);
  const closed = jobChecklistClosed(job);
  const scope = useMemo(
    () => ({
      businessId: workspace.businessId,
      membershipId: workspace.membershipId,
      jobId: job.id,
    }),
    [job.id, workspace.businessId, workspace.membershipId],
  );
  const [draft, setDraft] = useState<ChecklistDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingItemKey, setPendingItemKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadChecklistDraft(storage, scope)
      .then((loaded) => {
        if (!cancelled) setDraft(loaded);
      })
      .catch(() => {
        if (!cancelled) setError(CHECKLIST_DRAFT_STORAGE_ERROR);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, storage]);

  useEffect(() => {
    onUnsyncedChange?.(Boolean(draft && draft.items.length > 0));
  }, [draft, onUnsyncedChange]);

  if (!source) return null;

  const serverItems = source.items;
  const procedureTitle = source.procedureTitle;
  const items: ChecklistDisplayItem[] = overlayChecklistDraft(serverItems, draft);
  const unsynced = Boolean(draft && draft.items.length > 0);
  const editingLocked = closed || syncing || Boolean(pendingItemKey);

  async function recordLocalItem(itemKey: string, checked: boolean) {
    if (pendingItemKey || syncing || closed) return;
    setPendingItemKey(itemKey);
    setError(null);
    try {
      const next = await persistLocalChecklistChange(storage, {
        scope,
        serverItems,
        itemKey,
        checked,
      });
      setDraft(next);
    } catch (cause) {
      setError(
        cause instanceof ChecklistDraftStorageError
          ? cause.message
          : CHECKLIST_DRAFT_STORAGE_ERROR,
      );
    } finally {
      setPendingItemKey(null);
    }
  }

  async function reloadAssignedJob() {
    const reloaded = await loadNativeJob(token, job.id);
    if (!isApiError(reloaded)) {
      onJobUpdated(reloaded.job);
    }
  }

  async function syncDraft() {
    if (!draft || syncing || pendingItemKey || closed) return;
    setSyncing(true);
    setError(null);
    try {
      const result = await syncNativeJobChecklistDraft(token, job.id, {
        expectedFingerprint: draft.expectedFingerprint,
        items: draft.items,
      });
      if (isApiError(result)) {
        setError(result.error);
        if (result.error.includes("changed after your draft")) {
          await reloadAssignedJob();
        }
        return;
      }
      await clearChecklistDraft(storage, scope);
      setDraft(null);
      onJobUpdated(result.job);
    } catch {
      setError(NATIVE_CHECKLIST_OFFLINE_MESSAGE);
    } finally {
      setSyncing(false);
    }
  }

  async function discardDraft() {
    if (syncing) return;
    try {
      await clearChecklistDraft(storage, scope);
      setDraft(null);
      setError(null);
    } catch {
      setError(CHECKLIST_DRAFT_STORAGE_ERROR);
    }
  }

  return (
    <View style={styles.checklist}>
      <Text style={styles.groupTitle}>Crew checklist</Text>
      <Text style={styles.body}>
        {procedureTitle ?? "Crew checklist"}
      </Text>
      {closed ? <Text style={styles.notice}>{NATIVE_CHECKLIST_CLOSED_NOTICE}</Text> : null}
      {unsynced ? (
        <Text style={styles.unsynced}>Unsynced checklist changes</Text>
      ) : null}
      {items.map((item) => {
        const itemUnsynced = draft?.items.some((change) => change.itemKey === item.key);
        return (
          <View key={item.key} style={styles.checklistItem}>
            <Pressable
              disabled={editingLocked}
              onPress={() => {
                void recordLocalItem(item.key, !item.checked);
              }}
              style={[
                item.checked ? styles.secondaryAction : styles.primaryAction,
                styles.checklistAction,
                editingLocked ? styles.disabled : null,
              ]}
            >
              <Text style={styles.actionLabel}>
                {pendingItemKey === item.key
                  ? item.checked
                    ? "Done"
                    : "Mark done"
                  : itemUnsynced
                    ? "Saved on this phone"
                    : item.checked
                      ? "Done"
                      : "Mark done"}
              </Text>
            </Pressable>
            <Text style={styles.body}>{item.title}</Text>
            {itemUnsynced ? <Text style={styles.itemUnsynced}>Unsynced</Text> : null}
          </View>
        );
      })}
      {unsynced && !closed ? (
        <Pressable
          disabled={syncing || Boolean(pendingItemKey)}
          onPress={() => {
            void syncDraft();
          }}
          style={[styles.primaryAction, syncing ? styles.disabled : null]}
        >
          <Text style={styles.actionLabel}>{syncing ? "Syncing…" : "Sync checklist"}</Text>
        </Pressable>
      ) : null}
      {unsynced ? (
        <Pressable
          disabled={syncing}
          onPress={() => {
            void discardDraft();
          }}
        >
          <Text style={styles.discard}>Discard unsynced changes</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  checklist: {
    gap: 8,
    marginTop: 4,
  },
  checklistItem: {
    gap: 6,
  },
  checklistAction: {
    alignSelf: "flex-start",
    paddingVertical: 10,
    marginTop: 0,
  },
  primaryAction: {
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  secondaryAction: {
    backgroundColor: "#1f2937",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  disabled: {
    opacity: 0.6,
  },
  actionLabel: {
    color: "#f9fafb",
    fontWeight: "700",
    fontSize: 16,
  },
  body: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: "#fca5a5",
  },
  notice: {
    color: "#fbbf24",
    fontSize: 15,
    lineHeight: 22,
  },
  unsynced: {
    color: "#fbbf24",
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 22,
  },
  itemUnsynced: {
    color: "#fbbf24",
    fontSize: 13,
    fontWeight: "700",
  },
  discard: {
    color: "#93c5fd",
    fontWeight: "600",
  },
  groupTitle: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginTop: 12,
    textTransform: "uppercase",
  },
});
