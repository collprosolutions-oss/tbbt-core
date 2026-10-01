import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { isApiError, requestNativeJobTimeCorrection } from "../api";
import type { NativeJobDetail, NativeTimeCorrectionEntry } from "../types";

type CorrectionDraft = {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
};

function emptyDraft(entry: NativeTimeCorrectionEntry): CorrectionDraft {
  return {
    startDate: entry.startDate,
    startTime: entry.startTime,
    endDate: entry.endDate,
    endTime: entry.endTime,
    reason: "",
  };
}

export function JobTimeCorrectionSection({
  token,
  jobId,
  entries,
  truncatedNotice,
  onJobUpdated,
}: {
  token: string;
  jobId: string;
  entries: NativeTimeCorrectionEntry[];
  truncatedNotice?: string | null;
  onJobUpdated: (job: NativeJobDetail) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, CorrectionDraft>>({});
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts((current) => {
      const next: Record<string, CorrectionDraft> = {};
      for (const entry of entries) {
        next[entry.id] = current[entry.id] ?? emptyDraft(entry);
      }
      return next;
    });
  }, [entries]);

  async function requestCorrection(entry: NativeTimeCorrectionEntry) {
    if (pendingEntryId) return;
    const draft = drafts[entry.id] ?? emptyDraft(entry);
    setPendingEntryId(entry.id);
    setError(null);
    const result = await requestNativeJobTimeCorrection(token, jobId, {
      timeEntryId: entry.id,
      reason: draft.reason.trim(),
      proposedStartDate: draft.startDate.trim(),
      proposedStartTime: draft.startTime.trim(),
      proposedEndDate: draft.endDate.trim(),
      proposedEndTime: draft.endTime.trim(),
    });
    if (isApiError(result)) {
      setPendingEntryId(null);
      setError(result.error);
      return;
    }
    onJobUpdated(result.job);
    setPendingEntryId(null);
  }

  if (entries.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.groupTitle}>Request a time correction</Text>
      <Text style={styles.body}>
        Propose new start and end times for your own recorded time on this assigned job. The original clock stays until an owner accepts or declines.
      </Text>
      {truncatedNotice ? <Text style={styles.notice}>{truncatedNotice}</Text> : null}
      {entries.map((entry) => {
        const draft = drafts[entry.id] ?? emptyDraft(entry);
        return (
          <View key={entry.id} style={styles.card}>
            <Text style={styles.name}>
              {entry.activityLabel}
              {entry.hoursLabel ? ` · ${entry.hoursLabel}` : ""}
            </Text>
            <Text style={styles.meta}>
              Recorded {entry.startedAtLabel} – {entry.endedAtLabel}
            </Text>
            {entry.requestStatusLabel ? (
              <Text style={styles.recorded}>
                {entry.requestStatusLabel}
                {entry.proposedClockLabel ? ` · proposed ${entry.proposedClockLabel}` : ""}
                {entry.requestReason ? ` — ${entry.requestReason}` : ""}
              </Text>
            ) : null}
            {entry.canRequest ? (
              <>
                <View style={styles.times}>
                  <TextInput
                    onChangeText={(startDate: string) => {
                      setDrafts((current) => ({
                        ...current,
                        [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), startDate },
                      }));
                    }}
                    placeholder="Start date"
                    placeholderTextColor="#6b7280"
                    style={styles.input}
                    value={draft.startDate}
                  />
                  <TextInput
                    onChangeText={(startTime: string) => {
                      setDrafts((current) => ({
                        ...current,
                        [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), startTime },
                      }));
                    }}
                    placeholder="Start time"
                    placeholderTextColor="#6b7280"
                    style={styles.input}
                    value={draft.startTime}
                  />
                  <TextInput
                    onChangeText={(endDate: string) => {
                      setDrafts((current) => ({
                        ...current,
                        [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), endDate },
                      }));
                    }}
                    placeholder="End date"
                    placeholderTextColor="#6b7280"
                    style={styles.input}
                    value={draft.endDate}
                  />
                  <TextInput
                    onChangeText={(endTime: string) => {
                      setDrafts((current) => ({
                        ...current,
                        [entry.id]: { ...(current[entry.id] ?? emptyDraft(entry)), endTime },
                      }));
                    }}
                    placeholder="End time"
                    placeholderTextColor="#6b7280"
                    style={styles.input}
                    value={draft.endTime}
                  />
                </View>
                <TextInput
                  onChangeText={(reason: string) => {
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
                  style={[
                    styles.action,
                    pendingEntryId != null ? styles.actionDisabled : null,
                  ]}
                >
                  <Text style={styles.actionLabel}>
                    {pendingEntryId === entry.id ? "Sending request…" : "Request correction"}
                  </Text>
                </Pressable>
              </>
            ) : null}
            {!entry.canRequest && entry.blockedReason ? (
              <Text style={styles.meta}>{entry.blockedReason}</Text>
            ) : null}
          </View>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
    marginTop: 4,
  },
  groupTitle: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginTop: 12,
    textTransform: "uppercase",
  },
  body: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 22,
  },
  notice: {
    color: "#fbbf24",
    fontSize: 14,
    lineHeight: 20,
  },
  card: {
    gap: 8,
    borderColor: "#374151",
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  name: {
    color: "#f9fafb",
    fontSize: 16,
    fontWeight: "700",
  },
  meta: {
    color: "#9ca3af",
    fontSize: 14,
    lineHeight: 20,
  },
  recorded: {
    color: "#86efac",
    fontSize: 14,
    lineHeight: 20,
  },
  times: {
    gap: 8,
  },
  input: {
    backgroundColor: "#1f2937",
    borderRadius: 10,
    color: "#f9fafb",
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  action: {
    alignItems: "center",
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  actionLabel: {
    color: "#f9fafb",
    fontSize: 16,
    fontWeight: "700",
  },
  error: {
    color: "#fca5a5",
  },
});
