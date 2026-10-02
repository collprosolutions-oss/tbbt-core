import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  NATIVE_NETWORK_ERROR,
  isApiError,
  isLostAssignment,
  loadNativeTimeCards,
  requestNativeTimeCorrection,
} from "../api";
import type { NativeTimeCardEntry, NativeTimeCardsPayload, NativeWorkspace } from "../types";

type CorrectionDraft = {
  proposedStartDate: string;
  proposedStartTime: string;
  proposedEndDate: string;
  proposedEndTime: string;
  reason: string;
};

function emptyDraft(entry: NativeTimeCardEntry): CorrectionDraft {
  return {
    proposedStartDate: entry.startDate,
    proposedStartTime: entry.startTime,
    proposedEndDate: entry.endDate,
    proposedEndTime: entry.endTime,
    reason: "",
  };
}

export function TimeCardsScreen({
  token,
  workspace,
  onBack,
}: {
  token: string;
  workspace: NativeWorkspace;
  onBack: () => void;
}) {
  const [payload, setPayload] = useState<NativeTimeCardsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CorrectionDraft>>({});

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await loadNativeTimeCards(token);
      if (isApiError(result)) {
        setError(result.error);
        if (isLostAssignment(result)) {
          setPayload(null);
        }
        return;
      }
      setPayload(result);
      setError(null);
      setDrafts((current) => {
        const next: Record<string, CorrectionDraft> = {};
        for (const entry of result.entries) {
          next[entry.id] = current[entry.id] ?? emptyDraft(entry);
        }
        return next;
      });
    } catch {
      setError("Could not load time cards.");
    } finally {
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function reloadTimeCards(fallback: NativeTimeCardsPayload | null) {
    const reloaded = await loadNativeTimeCards(token);
    if (isApiError(reloaded)) {
      if (fallback) {
        setPayload(fallback);
        return;
      }
      setActionError(reloaded.error);
      return;
    }
    setPayload(reloaded);
    setDrafts((current) => {
      const next: Record<string, CorrectionDraft> = {};
      for (const entry of reloaded.entries) {
        next[entry.id] = current[entry.id] ?? emptyDraft(entry);
      }
      return next;
    });
  }

  async function requestCorrection(entry: NativeTimeCardEntry) {
    if (pendingEntryId) return;
    const draft = drafts[entry.id] ?? emptyDraft(entry);
    setPendingEntryId(entry.id);
    setActionError(null);
    setMessage(null);
    try {
      const result = await requestNativeTimeCorrection(token, {
        timeEntryId: entry.id,
        reason: draft.reason.trim(),
        proposedStartDate: draft.proposedStartDate.trim(),
        proposedStartTime: draft.proposedStartTime.trim(),
        proposedEndDate: draft.proposedEndDate.trim(),
        proposedEndTime: draft.proposedEndTime.trim(),
      });
      if (isApiError(result)) {
        if (isLostAssignment(result)) {
          setPayload(null);
          setError(result.error);
        }
        setActionError(result.error);
        return;
      }
      await reloadTimeCards(result.timeCards);
      setMessage(result.message);
    } catch {
      setActionError(NATIVE_NETWORK_ERROR);
    } finally {
      setPendingEntryId(null);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl onRefresh={refresh} refreshing={refreshing} />}
      style={styles.screen}
    >
      <Pressable onPress={onBack}>
        <Text style={styles.back}>Today</Text>
      </Pressable>
      <Text style={styles.kicker}>{workspace.businessName}</Text>
      <Text style={styles.title}>Time cards</Text>
      <Text style={styles.copy}>
        Propose new start and end times for your own recorded time. The original clock stays until
        an owner accepts or declines. Approved time and payroll stay on the owner surface.
      </Text>
      {error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          <Pressable
            onPress={() => {
              void refresh();
            }}
            style={styles.action}
          >
            <Text style={styles.actionLabel}>Retry</Text>
          </Pressable>
        </>
      ) : null}
      {!payload && !error ? <ActivityIndicator color="#86efac" /> : null}
      {payload && payload.entries.length === 0 ? (
        <Text style={styles.empty}>No recorded time to correct yet. Stop the clock first.</Text>
      ) : null}
      {payload
        ? payload.entries.map((entry) => {
            const draft = drafts[entry.id] ?? emptyDraft(entry);
            return (
              <View key={entry.id} style={styles.card}>
                <Text style={styles.cardTitle}>
                  {entry.activityLabel}
                  {entry.jobLabel ? ` · ${entry.jobLabel}` : ""}
                </Text>
                <Text style={styles.meta}>Recorded {entry.clockLabel}</Text>
                {entry.requestStatusLabel ? (
                  <Text style={styles.status}>
                    {entry.requestStatusLabel}
                    {entry.proposedClockLabel ? ` · proposed ${entry.proposedClockLabel}` : ""}
                    {entry.requestReason ? ` — ${entry.requestReason}` : ""}
                  </Text>
                ) : null}
                {entry.canRequest ? (
                  <View style={styles.form}>
                    <View style={styles.row}>
                      <TextInput
                        onChangeText={(proposedStartDate) => {
                          setDrafts((current) => ({
                            ...current,
                            [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), proposedStartDate },
                          }));
                        }}
                        placeholder="Start date YYYY-MM-DD"
                        placeholderTextColor="#6b7280"
                        style={styles.input}
                        value={draft.proposedStartDate}
                      />
                      <TextInput
                        onChangeText={(proposedStartTime) => {
                          setDrafts((current) => ({
                            ...current,
                            [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), proposedStartTime },
                          }));
                        }}
                        placeholder="Start HH:mm"
                        placeholderTextColor="#6b7280"
                        style={styles.input}
                        value={draft.proposedStartTime}
                      />
                    </View>
                    <View style={styles.row}>
                      <TextInput
                        onChangeText={(proposedEndDate) => {
                          setDrafts((current) => ({
                            ...current,
                            [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), proposedEndDate },
                          }));
                        }}
                        placeholder="End date YYYY-MM-DD"
                        placeholderTextColor="#6b7280"
                        style={styles.input}
                        value={draft.proposedEndDate}
                      />
                      <TextInput
                        onChangeText={(proposedEndTime) => {
                          setDrafts((current) => ({
                            ...current,
                            [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), proposedEndTime },
                          }));
                        }}
                        placeholder="End HH:mm"
                        placeholderTextColor="#6b7280"
                        style={styles.input}
                        value={draft.proposedEndTime}
                      />
                    </View>
                    <TextInput
                      onChangeText={(reason) => {
                        setDrafts((current) => ({
                          ...current,
                          [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), reason },
                        }));
                      }}
                      placeholder="Reason for the correction"
                      placeholderTextColor="#6b7280"
                      style={styles.input}
                      value={draft.reason}
                    />
                    <Pressable
                      disabled={pendingEntryId != null}
                      onPress={() => {
                        void requestCorrection(entry);
                      }}
                      style={[styles.action, pendingEntryId != null ? styles.actionDisabled : null]}
                    >
                      <Text style={styles.actionLabel}>
                        {pendingEntryId === entry.id ? "Sending request…" : "Request correction"}
                      </Text>
                    </Pressable>
                  </View>
                ) : entry.blockedReason ? (
                  <Text style={styles.notice}>{entry.blockedReason}</Text>
                ) : null}
              </View>
            );
          })
        : null}
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#111827",
  },
  content: {
    padding: 24,
    paddingTop: 64,
    gap: 16,
  },
  back: {
    color: "#86efac",
    fontWeight: "700",
  },
  kicker: {
    color: "#86efac",
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  title: {
    color: "#f9fafb",
    fontSize: 32,
    fontWeight: "700",
  },
  copy: {
    color: "#d1d5db",
    fontSize: 15,
    lineHeight: 22,
  },
  error: {
    color: "#fca5a5",
  },
  message: {
    color: "#86efac",
    fontSize: 14,
    lineHeight: 20,
  },
  empty: {
    color: "#9ca3af",
    borderColor: "#374151",
    borderStyle: "dashed",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  card: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  cardTitle: {
    color: "#f9fafb",
    fontSize: 18,
    fontWeight: "700",
  },
  meta: {
    color: "#d1d5db",
    fontSize: 14,
  },
  status: {
    color: "#86efac",
    fontSize: 13,
    lineHeight: 20,
  },
  notice: {
    color: "#fbbf24",
    fontSize: 14,
    lineHeight: 20,
  },
  form: {
    gap: 8,
    marginTop: 4,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: "#111827",
    borderColor: "#374151",
    borderRadius: 10,
    borderWidth: 1,
    color: "#f9fafb",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  action: {
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  actionDisabled: {
    opacity: 0.6,
  },
  actionLabel: {
    color: "#f9fafb",
    fontWeight: "700",
    fontSize: 16,
  },
});
