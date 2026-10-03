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
  nativePushPlatform,
  nativeScreenPaddingTop,
} from "../android";
import { NativeBuildStamp } from "./NativeBuildStamp";
import {
  isApiError,
  isLostAssignment,
  isSessionExpired,
  loadNativePushPreference,
  loadNativeToday,
  registerNativePushDevice,
  revokeNativePushDevice,
} from "../api";
import { readOrCreateNativePushDeviceToken } from "../session";
import { applyLostAssignment, nextNativeRequestGeneration, shouldApplyNativeResponse } from "../recovery";
import type {
  NativeAssignedStopsMaps,
  NativeJobSummary,
  NativePushPreferencePayload,
  NativeTodayPayload,
  NativeViewer,
  NativeWorkspace,
} from "../types";

function JobRow({
  job,
  onOpen,
}: {
  job: NativeJobSummary;
  onOpen: (jobId: string) => void;
}) {
  return (
    <Pressable onPress={() => onOpen(job.id)} style={styles.job}>
      <Text style={styles.jobTitle}>{job.customerName ?? "Assigned job"}</Text>
      <Text style={styles.jobMeta}>{job.whenLabel ?? "Unscheduled"}</Text>
      {job.address ? <Text style={styles.jobMeta}>{job.address}</Text> : null}
      <Text style={styles.jobStatus}>{job.status.replaceAll("_", " ")}</Text>
    </Pressable>
  );
}

function AssignedStopsMapsCard({ stops }: { stops: NativeAssignedStopsMaps }) {
  return (
    <View style={styles.stops}>
      <Text style={styles.groupTitle}>{stops.label}</Text>
      <Text style={styles.copy}>{stops.disclaimer}</Text>
      <Text style={styles.jobMeta}>{stops.orderNote}</Text>
      {stops.href ? (
        <Pressable
          onPress={() => {
            void Linking.openURL(stops.href!);
          }}
          style={styles.mapsAction}
        >
          <Text style={styles.mapsActionLabel}>{stops.label}</Text>
        </Pressable>
      ) : (
        <Text style={styles.empty}>{stops.emptyMessage ?? "No complete assigned stops for maps."}</Text>
      )}
      {stops.truncated && stops.truncatedNotice ? (
        <Text style={styles.truncated}>{stops.truncatedNotice}</Text>
      ) : null}
      {stops.excluded.length > 0 ? (
        <View style={styles.excluded}>
          <Text style={styles.groupTitle}>{stops.excludedHeading}</Text>
          {stops.excluded.map((stop) => (
            <Text key={stop.jobId} style={styles.jobMeta}>
              {stop.customerName} — {stop.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function JobAlertsCard({
  token,
  onSessionExpired,
}: {
  token: string;
  onSessionExpired: () => void;
}) {
  const [preference, setPreference] = useState<NativePushPreferencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const deviceToken = await readOrCreateNativePushDeviceToken();
    const result = await loadNativePushPreference(token, deviceToken);
    if (isApiError(result)) {
      if (isSessionExpired(result)) {
        onSessionExpired();
        return;
      }
      setError(result.error);
      return;
    }
    setPreference(result);
    setError(null);
  }, [onSessionExpired, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleAlerts() {
    if (busy) return;
    setBusy(true);
    try {
      const turningOn = !preference?.thisDeviceOptedIn;
      const deviceToken = await readOrCreateNativePushDeviceToken({
        requestPermission: turningOn,
      });
      const result = turningOn
        ? await registerNativePushDevice(token, {
            token: deviceToken,
            platform: nativePushPlatform(Platform.OS),
            optedIn: true,
          })
        : await revokeNativePushDevice(token, deviceToken);
      if (isApiError(result)) {
        if (isSessionExpired(result)) {
          onSessionExpired();
          return;
        }
        setError(result.error);
        return;
      }
      setPreference(result);
      setError(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.alerts}>
      <Text style={styles.groupTitle}>Job alerts</Text>
      <Text style={styles.copy}>
        {preference?.disclaimer ??
          "Job alerts are optional. A notice is informational only — it never starts your time or accepts an appointment."}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable
        disabled={busy}
        onPress={() => {
          void toggleAlerts();
        }}
        style={styles.timeCards}
      >
        <Text style={styles.timeCardsLabel}>
          {busy
            ? "Saving…"
            : preference?.thisDeviceOptedIn
              ? "Turn off job alerts"
              : "Turn on job alerts"}
        </Text>
      </Pressable>
    </View>
  );
}

function JobGroup({
  title,
  jobs,
  emptyLabel,
  onOpen,
}: {
  title: string;
  jobs: NativeJobSummary[];
  emptyLabel: string;
  onOpen: (jobId: string) => void;
}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      {jobs.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : (
        jobs.map((job) => <JobRow key={job.id} job={job} onOpen={onOpen} />)
      )}
    </View>
  );
}

export function TodayScreen({
  token,
  viewer,
  workspace,
  onOpenJob,
  onOpenTimeCards,
  onSessionExpired,
  onSignOut,
}: {
  token: string;
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  onOpenJob: (jobId: string) => void;
  onOpenTimeCards: () => void;
  onSessionExpired: () => void;
  onSignOut: () => void;
}) {
  const [payload, setPayload] = useState<NativeTodayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = nextNativeRequestGeneration(requestGeneration.current);
    requestGeneration.current = generation;
    setRefreshing(true);
    try {
      const result = await loadNativeToday(token);
      if (!shouldApplyNativeResponse(requestGeneration.current, generation)) return;
      if (isApiError(result)) {
        if (isSessionExpired(result)) {
          onSessionExpired();
          return;
        }
        setError(result.error);
        if (isLostAssignment(result)) {
          setPayload((current) => applyLostAssignment(current, result));
        }
        return;
      }
      setPayload(result);
      setError(null);
    } catch {
      if (!shouldApplyNativeResponse(requestGeneration.current, generation)) return;
      setError("Could not load Today.");
    } finally {
      if (shouldApplyNativeResponse(requestGeneration.current, generation)) {
        setRefreshing(false);
      }
    }
  }, [onSessionExpired, token]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current = nextNativeRequestGeneration(requestGeneration.current);
    };
  }, [refresh]);

  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: nativeScreenPaddingTop(Platform.OS, StatusBar.currentHeight) },
      ]}
      refreshControl={
        <RefreshControl
          colors={[...ANDROID_REFRESH_COLORS]}
          onRefresh={refresh}
          progressBackgroundColor={ANDROID_REFRESH_BACKGROUND}
          refreshing={refreshing}
          tintColor="#86efac"
        />
      }
      style={styles.screen}
    >
      <Text style={styles.kicker}>{workspace.businessName}</Text>
      <NativeBuildStamp />
      <Text style={styles.title}>Today</Text>
      <Text style={styles.copy}>
        Only jobs assigned to you, {viewer.name}. Other workers and owner records stay hidden.
      </Text>
      {payload?.truncated ? (
        <Text style={styles.truncated}>{payload.truncatedNotice ?? "This list is capped."}</Text>
      ) : null}
      <Pressable onPress={onOpenTimeCards} style={styles.timeCards}>
        <Text style={styles.timeCardsLabel}>Time cards</Text>
      </Pressable>
      <JobAlertsCard onSessionExpired={onSessionExpired} token={token} />
      {error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          <Pressable
            onPress={() => {
              void refresh();
            }}
            style={styles.timeCards}
          >
            <Text style={styles.timeCardsLabel}>Retry</Text>
          </Pressable>
        </>
      ) : null}
      {!payload && !error ? <ActivityIndicator color="#86efac" /> : null}
      {payload ? (
        <>
          <AssignedStopsMapsCard stops={payload.assignedStops} />
          <JobGroup title="Today" jobs={payload.today} emptyLabel="Nothing assigned for today." onOpen={onOpenJob} />
          <JobGroup title="Upcoming" jobs={payload.upcoming} emptyLabel="No upcoming jobs assigned." onOpen={onOpenJob} />
          <JobGroup
            title="Completed / Recent"
            jobs={payload.completed}
            emptyLabel="No completed jobs yet."
            onOpen={onOpenJob}
          />
        </>
      ) : null}
      <Pressable onPress={onSignOut} style={styles.signOut}>
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
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
  truncated: {
    color: "#fde68a",
    fontSize: 14,
    lineHeight: 20,
  },
  group: {
    gap: 8,
  },
  groupTitle: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  empty: {
    color: "#9ca3af",
    borderColor: "#374151",
    borderStyle: "dashed",
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  job: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 16,
    gap: 4,
  },
  jobTitle: {
    color: "#f9fafb",
    fontSize: 18,
    fontWeight: "700",
  },
  jobMeta: {
    color: "#d1d5db",
    fontSize: 14,
  },
  jobStatus: {
    color: "#86efac",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 4,
  },
  stops: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  mapsAction: {
    alignSelf: "flex-start",
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  mapsActionLabel: {
    color: "#f9fafb",
    fontWeight: "700",
  },
  excluded: {
    gap: 4,
    marginTop: 4,
  },
  alerts: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  timeCards: {
    alignSelf: "flex-start",
    backgroundColor: "#1f2937",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  timeCardsLabel: {
    color: "#f9fafb",
    fontWeight: "700",
  },
  signOut: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingVertical: 10,
  },
  signOutLabel: {
    color: "#fca5a5",
    fontWeight: "600",
  },
});
