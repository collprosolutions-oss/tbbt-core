import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { isApiError, recordNativeJobProblem } from "../api";
import type {
  NativeJobDetail,
  NativeJobProblemKind,
  NativeJobProblemReports,
} from "../types";

const KINDS: Array<{ value: NativeJobProblemKind; label: string }> = [
  { value: "ACCESS", label: "Access issue" },
  { value: "UNEXPECTED_CONDITION", label: "Unexpected condition" },
  { value: "MATERIAL", label: "Damaged or missing material" },
  { value: "CANNOT_PROCEED", label: "Work cannot proceed" },
  { value: "SAFETY", label: "Safety concern" },
  { value: "CUSTOMER_UNAVAILABLE", label: "Customer unavailable" },
];

export function JobProblemReportsSection({
  token,
  jobId,
  reports,
  onJobUpdated,
}: {
  token: string;
  jobId: string;
  reports: NativeJobProblemReports | null | undefined;
  onJobUpdated: (job: NativeJobDetail) => void;
}) {
  const [kind, setKind] = useState<NativeJobProblemKind | null>(null);
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (!reports) return null;

  async function sendReport() {
    if (pending || !kind) return;
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await recordNativeJobProblem(token, jobId, {
      kind,
      description,
    });
    if (isApiError(result)) {
      setPending(false);
      setError(result.error);
      return;
    }
    onJobUpdated(result.job);
    setDescription("");
    setKind(null);
    setMessage(
      result.alreadyRecorded
        ? "That report is already on this job."
        : "Problem reported. The office has been notified.",
    );
    setPending(false);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.groupTitle}>Field reports</Text>
      <Text style={styles.body}>
        Record a factual problem on this assigned job. This does not complete,
        cancel, or reschedule the job and does not message the customer.
      </Text>
      {reports.items.length === 0 ? (
        <Text style={styles.body}>No field reports yet.</Text>
      ) : (
        reports.items.map((report) => (
          <View key={report.id} style={styles.card}>
            <Text style={styles.status}>{report.statusLabel}</Text>
            {report.kindLabel ? <Text style={styles.meta}>{report.kindLabel}</Text> : null}
            <Text style={styles.body}>{report.description}</Text>
            <Text style={styles.meta}>Reported {report.reportedAtLabel}</Text>
          </View>
        ))
      )}
      {reports.truncatedNotice ? (
        <Text style={styles.notice}>{reports.truncatedNotice}</Text>
      ) : null}
      {reports.recordAction.available ? (
        <View style={styles.form}>
          <Text style={styles.body}>What's going on?</Text>
          <View style={styles.kinds}>
            {KINDS.map((choice) => {
              const selected = kind === choice.value;
              return (
                <Pressable
                  key={choice.value}
                  onPress={() => {
                    setKind(selected ? null : choice.value);
                  }}
                  style={[styles.chip, selected ? styles.chipSelected : null]}
                >
                  <Text style={styles.chipLabel}>{choice.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <TextInput
            multiline
            onChangeText={setDescription}
            placeholder="Access issue (can't get in / no one home)"
            placeholderTextColor="#6b7280"
            style={styles.input}
            value={description}
          />
          <Pressable
            disabled={pending}
            onPress={() => {
              void sendReport();
            }}
            style={[styles.action, pending ? styles.actionDisabled : null]}
          >
            <Text style={styles.actionLabel}>{pending ? "Sending…" : "Send report"}</Text>
          </Pressable>
        </View>
      ) : reports.recordAction.reason ? (
        <Text style={styles.notice}>{reports.recordAction.reason}</Text>
      ) : null}
      {message ? <Text style={styles.recorded}>{message}</Text> : null}
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
  card: {
    gap: 4,
    borderColor: "#374151",
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  status: {
    color: "#86efac",
    fontWeight: "700",
  },
  meta: {
    color: "#d1d5db",
    fontSize: 13,
    lineHeight: 20,
  },
  notice: {
    color: "#fbbf24",
    fontSize: 15,
    lineHeight: 22,
  },
  recorded: {
    color: "#86efac",
    fontSize: 14,
    lineHeight: 20,
  },
  form: {
    gap: 8,
  },
  kinds: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    backgroundColor: "#1f2937",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipSelected: {
    backgroundColor: "#166534",
  },
  chipLabel: {
    color: "#f9fafb",
    fontWeight: "600",
  },
  input: {
    backgroundColor: "#1f2937",
    borderRadius: 10,
    color: "#f9fafb",
    fontSize: 16,
    minHeight: 88,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: "top",
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
