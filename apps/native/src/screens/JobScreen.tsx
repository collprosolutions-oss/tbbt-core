import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  ANDROID_REFRESH_BACKGROUND,
  ANDROID_REFRESH_COLORS,
  nativeScreenPaddingTop,
} from "../android";
import { useAndroidHardwareBack } from "../use-android-back";
import {
  NATIVE_NETWORK_ERROR,
  NATIVE_TIME_CARD_OFFLINE_MESSAGE,
  completeNativeJob,
  isApiError,
  isLostAssignment,
  isNativeNetworkError,
  isSessionExpired,
  loadNativeJob,
  recordNativeJobVisit,
  startNativeActivityTime,
  startNativeJob,
  stopNativeActivityTime,
  stopNativeJobRunningTime,
  syncNativeJobTimeDraft,
  type NativeApiError,
} from "../api";
import { nextNativeRequestGeneration, shouldApplyNativeResponse } from "../recovery";
import { secureTimeCardDraftStorage } from "../time-card-draft-storage";
import {
  TIME_CARD_DRAFT_STORAGE_ERROR,
  TimeCardDraftStorageError,
  clearTimeCardDraft,
  draftHasTimeCardAction,
  loadTimeCardDraft,
  persistLocalTimeCardIntent,
  timeCardDraftActionLabel,
  timeCardSnapshotFromJob,
  type TimeCardDraft,
  type TimeCardDraftAction,
  type TimeCardDraftStorage,
} from "../time-card-drafts";
import type {
  NativeFieldActivityType,
  NativeJobDetail,
  NativeVisitOutcomeStatus,
  NativeWorkspace,
} from "../types";
import { JobChecklistSection } from "./JobChecklistSection";
import { JobMilestonesSection } from "./JobMilestonesSection";
import { JobPhotosSection } from "./JobPhotosSection";
import { JobPickupSection } from "./JobPickupSection";
import { JobProblemReportsSection } from "./JobProblemReportsSection";

export function JobScreen({
  token,
  jobId,
  workspace,
  onBack,
  onSessionExpired,
  storage = secureTimeCardDraftStorage,
}: {
  token: string;
  jobId: string;
  workspace: NativeWorkspace;
  onBack: () => void;
  onSessionExpired: () => void;
  storage?: TimeCardDraftStorage;
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
  const [unsyncedChecklist, setUnsyncedChecklist] = useState(false);
  const [timeDraft, setTimeDraft] = useState<TimeCardDraft | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);
  const actionsLocked = pending || refreshing;
  const unsyncedTime = Boolean(timeDraft && timeDraft.intents.length > 0);
  const timeScope = {
    businessId: workspace.businessId,
    membershipId: workspace.membershipId,
    jobId,
  };
  useAndroidHardwareBack(onBack);

  function beginAssignedRequest() {
    requestGeneration.current = nextNativeRequestGeneration(requestGeneration.current);
    return requestGeneration.current;
  }

  function applyLostAssignment(result: NativeApiError) {
    if (isSessionExpired(result)) {
      onSessionExpired();
      return;
    }
    if (isLostAssignment(result)) {
      setJob(null);
    }
    setError(result.error);
    setActionError(result.error);
  }

  useEffect(() => {
    const generation = beginAssignedRequest();
    void loadNativeJob(token, jobId).then((result) => {
      if (!shouldApplyNativeResponse(requestGeneration.current, generation)) return;
      if (isApiError(result)) {
        applyLostAssignment(result);
        return;
      }
      setJob(result.job);
      setError(null);
    });
    return () => {
      requestGeneration.current = nextNativeRequestGeneration(requestGeneration.current);
    };
  }, [jobId, token]);

  useEffect(() => {
    let cancelled = false;
    void loadTimeCardDraft(storage, timeScope)
      .then((loaded) => {
        if (!cancelled) setTimeDraft(loaded);
      })
      .catch(() => {
        if (!cancelled) setActionError(TIME_CARD_DRAFT_STORAGE_ERROR);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, storage, workspace.businessId, workspace.membershipId]);

  function clockSnapshot(current: NativeJobDetail) {
    return timeCardSnapshotFromJob({
      jobStatus: current.status,
      assignmentId: workspace.membershipId,
      runningTime: current.runningTime,
      travelTime: current.travelTime,
      pickupTime: current.pickupTime,
    });
  }

  async function recordOfflineIntent(action: TimeCardDraftAction, current: NativeJobDetail) {
    const next = await persistLocalTimeCardIntent(storage, {
      scope: timeScope,
      snapshot: clockSnapshot(current),
      action,
    });
    setTimeDraft(next);
  }

  async function reloadAssignedJob(fallback: NativeJobDetail | null) {
    const generation = beginAssignedRequest();
    const reloaded = await loadNativeJob(token, jobId);
    if (!shouldApplyNativeResponse(requestGeneration.current, generation)) return;
    if (isApiError(reloaded)) {
      if (isSessionExpired(reloaded) || isLostAssignment(reloaded)) {
        applyLostAssignment(reloaded);
        return;
      }
      if (fallback) {
        setJob(fallback);
        return;
      }
      setActionError(reloaded.error);
      return;
    }
    setRefreshing(false);
    setJob(reloaded.job);
    setError(null);
  }

  const retryAssignedJob = useCallback(async () => {
    const generation = beginAssignedRequest();
    setRefreshing(true);
    setError(null);
    setActionError(null);
    const reloaded = await loadNativeJob(token, jobId);
    if (!shouldApplyNativeResponse(requestGeneration.current, generation)) return;
    setRefreshing(false);
    if (isApiError(reloaded)) {
      applyLostAssignment(reloaded);
    } else {
      setJob(reloaded.job);
    }
  }, [jobId, onSessionExpired, token]);

  async function startAssignedJob() {
    if (actionsLocked || !job) return;
    setPending(true);
    setPendingAction("start");
    setActionError(null);
    try {
      if (unsyncedTime) {
        await recordOfflineIntent("START_JOB", job);
        return;
      }
      const result = await startNativeJob(token, jobId);
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        if (isNativeNetworkError(result)) {
          await recordOfflineIntent("START_JOB", job);
          return;
        }
        setActionError(result.error);
        return;
      }
      await reloadAssignedJob(result.job);
    } catch (cause) {
      setActionError(
        cause instanceof TimeCardDraftStorageError ? cause.message : NATIVE_NETWORK_ERROR,
      );
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  }

  async function stopAssignedJobTime() {
    if (actionsLocked || !job) return;
    setPending(true);
    setPendingAction("stop");
    setActionError(null);
    try {
      if (unsyncedTime) {
        await recordOfflineIntent("STOP_JOB_TIME", job);
        return;
      }
      const result = await stopNativeJobRunningTime(token, jobId);
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        if (isNativeNetworkError(result)) {
          await recordOfflineIntent("STOP_JOB_TIME", job);
          return;
        }
        setActionError(result.error);
        return;
      }
      await reloadAssignedJob(result.job);
    } catch (cause) {
      setActionError(
        cause instanceof TimeCardDraftStorageError ? cause.message : NATIVE_NETWORK_ERROR,
      );
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  }

  async function startAssignedActivity(activityType: NativeFieldActivityType) {
    if (actionsLocked || !job) return;
    const action: TimeCardDraftAction =
      activityType === "TRAVEL" ? "START_TRAVEL" : "START_PICKUP";
    setPending(true);
    setPendingAction(activityType === "TRAVEL" ? "start-travel" : "start-pickup");
    setActionError(null);
    try {
      if (unsyncedTime) {
        await recordOfflineIntent(action, job);
        return;
      }
      const result = await startNativeActivityTime(token, jobId, activityType);
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        if (isNativeNetworkError(result)) {
          await recordOfflineIntent(action, job);
          return;
        }
        setActionError(result.error);
        return;
      }
      await reloadAssignedJob(result.job);
    } catch (cause) {
      setActionError(
        cause instanceof TimeCardDraftStorageError ? cause.message : NATIVE_NETWORK_ERROR,
      );
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  }

  async function stopAssignedActivity(activityType: NativeFieldActivityType) {
    if (actionsLocked || !job) return;
    const action: TimeCardDraftAction =
      activityType === "TRAVEL" ? "STOP_TRAVEL" : "STOP_PICKUP";
    setPending(true);
    setPendingAction(activityType === "TRAVEL" ? "stop-travel" : "stop-pickup");
    setActionError(null);
    try {
      if (unsyncedTime) {
        await recordOfflineIntent(action, job);
        return;
      }
      const result = await stopNativeActivityTime(token, jobId, activityType);
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        if (isNativeNetworkError(result)) {
          await recordOfflineIntent(action, job);
          return;
        }
        setActionError(result.error);
        return;
      }
      await reloadAssignedJob(result.job);
    } catch (cause) {
      setActionError(
        cause instanceof TimeCardDraftStorageError ? cause.message : NATIVE_NETWORK_ERROR,
      );
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  }

  async function syncTimeDraft() {
    if (!timeDraft || actionsLocked) return;
    setPending(true);
    setActionError(null);
    try {
      const result = await syncNativeJobTimeDraft(token, jobId, {
        expectedFingerprint: timeDraft.expectedFingerprint,
        intents: timeDraft.intents,
      });
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        setActionError(result.error);
        if (result.error.includes("changed after your draft")) {
          await reloadAssignedJob(job);
        }
        return;
      }
      try {
        await clearTimeCardDraft(storage, timeScope);
        setTimeDraft(null);
      } catch {
        setActionError(TIME_CARD_DRAFT_STORAGE_ERROR);
      }
      await reloadAssignedJob(result.job);
    } catch {
      setActionError(NATIVE_TIME_CARD_OFFLINE_MESSAGE);
    } finally {
      setPending(false);
    }
  }

  async function discardTimeDraft() {
    if (actionsLocked) return;
    try {
      await clearTimeCardDraft(storage, timeScope);
      setTimeDraft(null);
      setActionError(null);
    } catch {
      setActionError(TIME_CARD_DRAFT_STORAGE_ERROR);
    }
  }

  async function completeAssignedJob() {
    if (actionsLocked) return;
    if (unsyncedTime) {
      setActionError("Sync or discard unsynced time before completing this job.");
      return;
    }
    if (unsyncedChecklist) {
      setActionError("Sync or discard unsynced checklist changes before completing this job.");
      return;
    }
    setPending(true);
    setPendingAction("complete");
    setActionError(null);
    try {
      const result = await completeNativeJob(token, jobId);
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        setActionError(result.error);
        return;
      }
      await reloadAssignedJob(result.job);
    } catch {
      setActionError(NATIVE_NETWORK_ERROR);
    } finally {
      setPending(false);
      setPendingAction(null);
    }
  }

  async function recordVisitOutcome(outcomeStatus: NativeVisitOutcomeStatus) {
    if (actionsLocked) return;
    if (unsyncedTime) {
      setActionError("Sync or discard unsynced time before recording a visit outcome.");
      return;
    }
    if (unsyncedChecklist) {
      setActionError(
        "Sync or discard unsynced checklist changes before recording a visit outcome.",
      );
      return;
    }
    setPending(true);
    setPendingOutcome(outcomeStatus);
    setActionError(null);
    try {
      const result = await recordNativeJobVisit(token, jobId, outcomeStatus);
      if (isApiError(result)) {
        if (isSessionExpired(result) || isLostAssignment(result)) {
          applyLostAssignment(result);
          return;
        }
        setActionError(result.error);
        return;
      }
      await reloadAssignedJob(result.job);
    } catch {
      setActionError(NATIVE_NETWORK_ERROR);
    } finally {
      setPending(false);
      setPendingOutcome(null);
    }
  }

  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: nativeScreenPaddingTop(Platform.OS, StatusBar.currentHeight) },
      ]}
      refreshControl={
        <RefreshControl
          colors={[...ANDROID_REFRESH_COLORS]}
          onRefresh={retryAssignedJob}
          progressBackgroundColor={ANDROID_REFRESH_BACKGROUND}
          refreshing={refreshing}
          tintColor="#86efac"
        />
      }
      style={styles.screen}
    >
      <Pressable onPress={onBack}>
        <Text style={styles.back}>Today</Text>
      </Pressable>
      {error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          <Pressable
            onPress={() => {
              void retryAssignedJob();
            }}
            style={styles.secondaryAction}
          >
            <Text style={styles.primaryActionLabel}>Retry</Text>
          </Pressable>
          <Pressable onPress={onSessionExpired} style={styles.secondaryAction}>
            <Text style={styles.primaryActionLabel}>Sign in again</Text>
          </Pressable>
        </>
      ) : null}
      {!job && !error ? <ActivityIndicator color="#86efac" /> : null}
      {job ? (
        <View style={styles.stack}>
          <Text style={styles.title}>{job.customerName ?? "Assigned job"}</Text>
          <Text style={styles.meta}>{job.whenLabel ?? "Unscheduled"}</Text>
          <Text style={styles.meta}>{job.confirmationLabel}</Text>
          <Text style={styles.status}>{job.status.replaceAll("_", " ")}</Text>
          <Pressable
            disabled={refreshing || pending}
            onPress={() => {
              void retryAssignedJob();
            }}
            style={styles.reload}
          >
            <Text style={styles.reloadLabel}>{refreshing ? "Reloading…" : "Reload"}</Text>
          </Pressable>
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
          {unsyncedTime ? (
            <Text style={styles.unsynced}>Unsynced time · Saved on this phone</Text>
          ) : null}
          {timeDraft?.intents.map((intent) => (
            <Text key={`${intent.action}-${intent.intendedAt}`} style={styles.unsyncedItem}>
              {timeCardDraftActionLabel(intent.action)} · not approved server time
            </Text>
          )) ?? null}
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
              disabled={actionsLocked}
              onPress={() => {
                void startAssignedJob();
              }}
              style={[styles.primaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "start"
                  ? "Starting…"
                  : draftHasTimeCardAction(timeDraft, "START_JOB")
                    ? "Saved on this phone"
                    : "Start job"}
              </Text>
            </Pressable>
          ) : job.startAction.reason ? (
            <Text style={styles.notice}>{job.startAction.reason}</Text>
          ) : null}
          {job.stopTimeAction.available || draftHasTimeCardAction(timeDraft, "START_JOB") ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void stopAssignedJobTime();
              }}
              style={[styles.secondaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "stop"
                  ? "Stopping…"
                  : draftHasTimeCardAction(timeDraft, "STOP_JOB_TIME")
                    ? "Saved on this phone"
                    : "Stop job time"}
              </Text>
            </Pressable>
          ) : null}
          {job.startTravelAction?.available ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void startAssignedActivity("TRAVEL");
              }}
              style={[styles.secondaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "start-travel"
                  ? "Starting…"
                  : draftHasTimeCardAction(timeDraft, "START_TRAVEL")
                    ? "Saved on this phone"
                    : "Start travel"}
              </Text>
            </Pressable>
          ) : null}
          {job.stopTravelAction?.available ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void stopAssignedActivity("TRAVEL");
              }}
              style={[styles.secondaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "stop-travel"
                  ? "Stopping…"
                  : draftHasTimeCardAction(timeDraft, "STOP_TRAVEL")
                    ? "Saved on this phone"
                    : "Stop travel"}
              </Text>
            </Pressable>
          ) : null}
          {job.startPickupAction?.available ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void startAssignedActivity("MATERIAL_PICKUP");
              }}
              style={[styles.secondaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "start-pickup"
                  ? "Starting…"
                  : draftHasTimeCardAction(timeDraft, "START_PICKUP")
                    ? "Saved on this phone"
                    : "Start material pickup"}
              </Text>
            </Pressable>
          ) : null}
          {job.stopPickupAction?.available ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void stopAssignedActivity("MATERIAL_PICKUP");
              }}
              style={[styles.secondaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "stop-pickup"
                  ? "Stopping…"
                  : draftHasTimeCardAction(timeDraft, "STOP_PICKUP")
                    ? "Saved on this phone"
                    : "Stop material pickup"}
              </Text>
            </Pressable>
          ) : null}
          {unsyncedTime ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void syncTimeDraft();
              }}
              style={[styles.primaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>{pending ? "Syncing…" : "Sync time"}</Text>
            </Pressable>
          ) : null}
          {unsyncedTime ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void discardTimeDraft();
              }}
            >
              <Text style={styles.discard}>Discard unsynced time</Text>
            </Pressable>
          ) : null}
          {job.completeAction.available ? (
            <Pressable
              disabled={actionsLocked}
              onPress={() => {
                void completeAssignedJob();
              }}
              style={[styles.primaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
            >
              <Text style={styles.primaryActionLabel}>
                {pendingAction === "complete" ? "Completing…" : "Complete job"}
              </Text>
            </Pressable>
          ) : job.status === "COMPLETED" ? (
            <Text style={styles.body}>
              This job is complete. The owner will review and send the invoice when ready.
            </Text>
          ) : job.completeAction.reason && !job.startAction.available && !job.startAction.reason ? (
            <Text style={styles.notice}>{job.completeAction.reason}</Text>
          ) : null}
          <JobChecklistSection
            job={job}
            onJobUpdated={setJob}
            onUnsyncedChange={setUnsyncedChecklist}
            token={token}
            workspace={workspace}
          />
          {job.visit ? (
            <View style={styles.visit}>
              <Text style={styles.groupTitle}>Visit outcome</Text>
              <Text style={styles.body}>
                {job.visit.cadenceLabel !== "One-time"
                  ? `${job.visit.cadenceLabel} visit. ${job.visit.outcomeLabel}`
                  : job.visit.outcomeLabel}
              </Text>
              {job.visit.recordCompleted.available ? (
                <Pressable
                  disabled={actionsLocked}
                  onPress={() => {
                    void recordVisitOutcome("VISIT_COMPLETED");
                  }}
                  style={[styles.primaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
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
                  disabled={actionsLocked}
                  onPress={() => {
                    void recordVisitOutcome("RE_CLEAN_REQUESTED");
                  }}
                  style={[styles.secondaryAction, actionsLocked ? styles.primaryActionDisabled : null]}
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
          <JobMilestonesSection milestones={job.milestones} />
          <JobProblemReportsSection
            jobId={job.id}
            onJobUpdated={setJob}
            reports={job.problemReports}
            token={token}
          />
          {job.pickupItems?.length ? (
            <JobPickupSection
              items={job.pickupItems}
              jobId={job.id}
              onJobUpdated={setJob}
              token={token}
            />
          ) : null}
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
  reload: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingVertical: 6,
  },
  reloadLabel: {
    color: "#86efac",
    fontWeight: "700",
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
  unsyncedItem: {
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
