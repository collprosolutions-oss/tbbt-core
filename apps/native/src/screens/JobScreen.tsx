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
import {
  completeNativeJob,
  isApiError,
  loadNativeJob,
  recordNativeJobChecklistItem,
  recordNativeJobVisit,
  startNativeActivityTime,
  startNativeJob,
  stopNativeActivityTime,
  stopNativeJobRunningTime,
} from "../api";
import type { NativeFieldActivityType, NativeJobDetail, NativeVisitOutcomeStatus } from "../types";
import { JobPhotosSection } from "./JobPhotosSection";

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
  const [pendingAction, setPendingAction] = useState<
    "start" | "complete" | "stop" | "start-travel" | "stop-travel" | "start-pickup" | "stop-pickup" | null
  >(null);
  const [pendingOutcome, setPendingOutcome] = useState<NativeVisitOutcomeStatus | null>(
    null,
  );
  const [pendingItemKey, setPendingItemKey] = useState<string | null>(null);

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
    setPendingAction("start");
    setActionError(null);
    const result = await startNativeJob(token, jobId);
    if (isApiError(result)) {
      setPending(false);
      setPendingAction(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingAction(null);
  }

  async function stopAssignedJobTime() {
    if (pending) return;
    setPending(true);
    setPendingAction("stop");
    setActionError(null);
    const result = await stopNativeJobRunningTime(token, jobId);
    if (isApiError(result)) {
      setPending(false);
      setPendingAction(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingAction(null);
  }

  async function startAssignedActivity(activityType: NativeFieldActivityType) {
    if (pending) return;
    setPending(true);
    setPendingAction(activityType === "TRAVEL" ? "start-travel" : "start-pickup");
    setActionError(null);
    const result = await startNativeActivityTime(token, jobId, activityType);
    if (isApiError(result)) {
      setPending(false);
      setPendingAction(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingAction(null);
  }

  async function stopAssignedActivity(activityType: NativeFieldActivityType) {
    if (pending) return;
    setPending(true);
    setPendingAction(activityType === "TRAVEL" ? "stop-travel" : "stop-pickup");
    setActionError(null);
    const result = await stopNativeActivityTime(token, jobId, activityType);
    if (isApiError(result)) {
      setPending(false);
      setPendingAction(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingAction(null);
  }

  async function completeAssignedJob() {
    if (pending) return;
    setPending(true);
    setPendingAction("complete");
    setActionError(null);
    const result = await completeNativeJob(token, jobId);
    if (isApiError(result)) {
      setPending(false);
      setPendingAction(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingAction(null);
  }

  async function recordChecklistItem(itemKey: string, checked: boolean) {
    if (pending) return;
    setPending(true);
    setPendingItemKey(itemKey);
    setActionError(null);
    const result = await recordNativeJobChecklistItem(token, jobId, { itemKey, checked });
    if (isApiError(result)) {
      setPending(false);
      setPendingItemKey(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingItemKey(null);
  }

  async function recordVisitOutcome(outcomeStatus: NativeVisitOutcomeStatus) {
    if (pending) return;
    setPending(true);
    setPendingOutcome(outcomeStatus);
    setActionError(null);
    const result = await recordNativeJobVisit(token, jobId, outcomeStatus);
    if (isApiError(result)) {
      setPending(false);
      setPendingOutcome(null);
      setActionError(result.error);
      return;
    }
    await reloadAssignedJob(result.job);
    setPending(false);
    setPendingOutcome(null);
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
              : job.runningTime.recorded
                ? `Recorded job time${
                    job.runningTime.hoursLabel ? ` · ${job.runningTime.hoursLabel}` : ""
                  }${
                    job.runningTime.endedAtLabel
                      ? ` · Ended ${job.runningTime.endedAtLabel}`
                      : ""
                  }`
                : "No running job time"}
          </Text>
          <Text style={styles.body}>
            {job.travelTime?.running
              ? `Travel running · Since ${job.travelTime.startedAtLabel ?? "now"}`
              : job.travelTime?.recorded
                ? `Recorded travel${
                    job.travelTime.hoursLabel ? ` · ${job.travelTime.hoursLabel}` : ""
                  }`
                : "No travel time"}
          </Text>
          <Text style={styles.body}>
            {job.pickupTime?.running
              ? `Material pickup running · Since ${job.pickupTime.startedAtLabel ?? "now"}`
              : job.pickupTime?.recorded
                ? `Recorded material pickup${
                    job.pickupTime.hoursLabel ? ` · ${job.pickupTime.hoursLabel}` : ""
                  }`
                : "No material pickup time"}
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
                {pendingAction === "start" ? "Starting…" : "Start job"}
              </Text>
            </Pressable>
          ) : job.startAction.reason ? (
            <Text style={styles.notice}>{job.startAction.reason}</Text>
          ) : null}
          {job.stopTimeAction.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void stopAssignedJobTime();
              }}
              style={[styles.secondaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "stop" ? "Stopping…" : "Stop job time"}
              </Text>
            </Pressable>
          ) : null}
          {job.startTravelAction?.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void startAssignedActivity("TRAVEL");
              }}
              style={[styles.secondaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "start-travel" ? "Starting…" : "Start travel"}
              </Text>
            </Pressable>
          ) : null}
          {job.stopTravelAction?.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void stopAssignedActivity("TRAVEL");
              }}
              style={[styles.secondaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "stop-travel" ? "Stopping…" : "Stop travel"}
              </Text>
            </Pressable>
          ) : null}
          {job.startPickupAction?.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void startAssignedActivity("MATERIAL_PICKUP");
              }}
              style={[styles.secondaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "start-pickup" ? "Starting…" : "Start material pickup"}
              </Text>
            </Pressable>
          ) : null}
          {job.stopPickupAction?.available ? (
            <Pressable
              disabled={pending}
              onPress={() => {
                void stopAssignedActivity("MATERIAL_PICKUP");
              }}
              style={[styles.secondaryAction, pending ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "stop-pickup" ? "Stopping…" : "Stop material pickup"}
              </Text>
            </Pressable>
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
                {pendingAction === "complete" ? "Completing…" : "Complete job"}
              </Text>
            </Pressable>
          ) : job.status === "COMPLETED" ? (
            <Text style={styles.body}>This job is complete.</Text>
          ) : job.completeAction.reason && !job.startAction.available && !job.startAction.reason ? (
            <Text style={styles.notice}>{job.completeAction.reason}</Text>
          ) : null}
          {job.visit ? (
            <View style={styles.visit}>
              {job.visit.checklist.length > 0 ? (
                <View style={styles.checklist}>
                  <Text style={styles.groupTitle}>Crew checklist</Text>
                  <Text style={styles.body}>
                    {job.visit.procedureTitle ?? "Cleaning pack crew checklist"}
                  </Text>
                  {job.visit.checklist.map((item) => (
                    <View key={item.key} style={styles.checklistItem}>
                      <Pressable
                        disabled={pending}
                        onPress={() => {
                          void recordChecklistItem(item.key, !item.checked);
                        }}
                        style={[
                          item.checked ? styles.secondaryAction : styles.primaryAction,
                          styles.checklistAction,
                          pending ? styles.primaryActionDisabled : null,
                        ]}
                      >
                        <Text style={styles.primaryActionLabel}>
                          {pendingItemKey === item.key
                            ? "Saving…"
                            : item.checked
                              ? "Done"
                              : "Mark done"}
                        </Text>
                      </Pressable>
                      <Text style={styles.body}>{item.title}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              <Text style={styles.groupTitle}>Visit outcome</Text>
              <Text style={styles.body}>
                {job.visit.cadenceLabel !== "One-time"
                  ? `${job.visit.cadenceLabel} visit. ${job.visit.outcomeLabel}`
                  : job.visit.outcomeLabel}
              </Text>
              {job.visit.recordCompleted.available ? (
                <Pressable
                  disabled={pending}
                  onPress={() => {
                    void recordVisitOutcome("VISIT_COMPLETED");
                  }}
                  style={[styles.primaryAction, pending ? styles.primaryActionDisabled : null]}
                >
                  <Text style={styles.primaryActionLabel}>
                    {pendingOutcome === "VISIT_COMPLETED"
                      ? "Recording…"
                      : "Record visit completed"}
                  </Text>
                </Pressable>
              ) : job.visit.recordCompleted.reason ? (
                <Text style={styles.notice}>{job.visit.recordCompleted.reason}</Text>
              ) : null}
              {job.visit.recordReclean.available ? (
                <Pressable
                  disabled={pending}
                  onPress={() => {
                    void recordVisitOutcome("RE_CLEAN_REQUESTED");
                  }}
                  style={[styles.secondaryAction, pending ? styles.primaryActionDisabled : null]}
                >
                  <Text style={styles.primaryActionLabel}>
                    {pendingOutcome === "RE_CLEAN_REQUESTED" ? "Recording…" : "Request re-clean"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
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
          {job.photos ? (
            <JobPhotosSection
              jobId={job.id}
              onJobUpdated={setJob}
              photos={job.photos}
              token={token}
            />
          ) : null}
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
  visit: {
    gap: 8,
    marginTop: 4,
  },
  checklist: {
    gap: 8,
  },
  checklistItem: {
    gap: 6,
  },
  checklistAction: {
    alignSelf: "flex-start",
    paddingVertical: 10,
    marginTop: 0,
  },
  secondaryAction: {
    backgroundColor: "#1f2937",
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
