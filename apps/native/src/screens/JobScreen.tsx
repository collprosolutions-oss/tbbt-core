import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { completeNativeJob, isApiError, loadNativeJob, startNativeJob } from "../api";
import type { NativeJobDetail } from "../types";

export function JobScreen({
  token,
  jobId,
  onBack,
}: {
  token: string;
  jobId: string;
  onBack: () => void;
}) {
  const [job, setJob] = useState<NativeJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadNativeJob(token, jobId).then((result) => {
      if (cancelled) return;
      if (isApiError(result)) {
        setError(result.error);
        return;
      }
      setJob(result.job);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, token]);

  async function reloadAssignedJob(fallback: NativeJobDetail | null) {
    const reloaded = await loadNativeJob(token, jobId);
    if (isApiError(reloaded)) {
      if (fallback) {
        setJob(fallback);
        return;
      }
      setActionError(reloaded.error);
      return;
    }
    setJob(reloaded.job);
  }

  async function startAssignedJob() {
    if (pending) return;
    setPending(true);
    setActionError(null);
    const result = await startNativeJob(token, jobId);
    if (isApiError(result)) {
      setPending(false);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
  }

  async function completeAssignedJob() {
    if (pending) return;
    setPending(true);
    setActionError(null);
    const result = await completeNativeJob(token, jobId);
    if (isApiError(result)) {
      setPending(false);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
  }

  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
      <Pressable onPress={onBack}>
        <Text style={styles.back}>Today</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!job && !error ? <ActivityIndicator color="#86efac" /> : null}
      {job ? (
        <View style={styles.stack}>
          <Text style={styles.title}>{job.customerName ?? "Assigned job"}</Text>
          <Text style={styles.meta}>{job.whenLabel ?? "Unscheduled"}</Text>
          <Text style={styles.meta}>{job.confirmationLabel}</Text>
          <Text style={styles.status}>{job.status.replaceAll("_", " ")}</Text>
          <Text style={styles.body}>
            {job.runningTime.running
              ? `Time running · ${job.runningTime.activityLabel ?? "Job"} · Since ${
                  job.runningTime.startedAtLabel ?? "now"
                }`
              : "No running job time"}
          </Text>
          {job.address ? <Text style={styles.body}>{job.address}</Text> : null}
          {job.customerPhone ? <Text style={styles.body}>{job.customerPhone}</Text> : null}
          <View style={styles.actions}>
            {job.directionsHref ? (
              <Pressable onPress={() => Linking.openURL(job.directionsHref!)} style={styles.action}>
                <Text style={styles.actionLabel}>Directions</Text>
              </Pressable>
            ) : null}
            {job.callHref ? (
              <Pressable onPress={() => Linking.openURL(job.callHref!)} style={styles.action}>
                <Text style={styles.actionLabel}>Call</Text>
              </Pressable>
            ) : null}
          </View>
          {job.startAction.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void startAssignedJob();
              }}
              style={[styles.primaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pending ? "Starting…" : "Start job"}
              </Text>
            </Pressable>
          ) : job.startAction.reason ? (
            <Text style={styles.notice}>{job.startAction.reason}</Text>
          ) : null}
          {job.completeAction.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void completeAssignedJob();
              }}
              style={[styles.primaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pending ? "Completing…" : "Complete job"}
              </Text>
            </Pressable>
          ) : job.status === "COMPLETED" ? (
            <Text style={styles.body}>This job is complete.</Text>
          ) : job.completeAction.reason && !job.startAction.available && !job.startAction.reason ? (
            <Text style={styles.notice}>{job.completeAction.reason}</Text>
          ) : null}
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
          <Text style={styles.groupTitle}>Access</Text>
          {job.accessLines.map((line) => (
            <Text key={line} style={styles.body}>
              {line}
            </Text>
          ))}
          <Text style={styles.groupTitle}>Approved scope</Text>
          {job.scope.items.length === 0 ? (
            <Text style={styles.body}>No approved scope on this job.</Text>
          ) : (
            job.scope.items.map((item) => (
              <Text key={`${item.description}-${item.quantity}`} style={styles.body}>
                {item.quantity} × {item.description}
              </Text>
            ))
          )}
        </View>
      ) : null}
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
  error: {
    color: "#fca5a5",
  },
  stack: {
    gap: 8,
  },
  title: {
    color: "#f9fafb",
    fontSize: 28,
    fontWeight: "700",
  },
  meta: {
    color: "#d1d5db",
    fontSize: 15,
  },
  status: {
    color: "#86efac",
    fontWeight: "700",
  },
  body: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 22,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginVertical: 8,
  },
  action: {
    backgroundColor: "#1f2937",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  actionLabel: {
    color: "#f9fafb",
    fontWeight: "600",
  },
  primaryAction: {
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 4,
  },
  primaryActionDisabled: {
    opacity: 0.6,
  },
  primaryActionLabel: {
    color: "#f9fafb",
    fontWeight: "700",
    fontSize: 16,
  },
  notice: {
    color: "#fbbf24",
    fontSize: 15,
    lineHeight: 22,
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
