import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { isApiError, loadNativeSession, signOutNative } from "./src/api";
import { JobScreen } from "./src/screens/JobScreen";
import { SignInScreen } from "./src/screens/SignInScreen";
import { TimeCardsScreen } from "./src/screens/TimeCardsScreen";
import { TodayScreen } from "./src/screens/TodayScreen";
import { secureChecklistDraftStorage } from "./src/checklist-draft-storage";
import {
  applyChecklistDraftAccount,
  clearAllChecklistDrafts,
} from "./src/checklist-drafts";
import { secureTimeCardDraftStorage } from "./src/time-card-draft-storage";
import {
  applyTimeCardDraftAccount,
  clearAllTimeCardDrafts,
} from "./src/time-card-drafts";
import { clearSessionToken, readSessionToken } from "./src/session";
import type { NativeViewer, NativeWorkspace } from "./src/types";

type SessionState = {
  token: string;
  viewer: NativeViewer;
  workspace: NativeWorkspace;
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<SessionState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [timeCardsOpen, setTimeCardsOpen] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  async function restoreSession() {
    setRestoring(true);
    setRestoreError(null);
    const token = await readSessionToken();
    if (!token) {
      setSession(null);
      setReady(true);
      setRestoring(false);
      return;
    }
    const restored = await loadNativeSession(token);
    if (isApiError(restored)) {
      if (restored.status === 401 || restored.status === 403) {
        await clearSessionToken();
        setSession(null);
      } else {
        setRestoreError(restored.error);
      }
    } else {
      await applyChecklistDraftAccount(secureChecklistDraftStorage, {
        businessId: restored.workspace.businessId,
        membershipId: restored.workspace.membershipId,
      });
      await applyTimeCardDraftAccount(secureTimeCardDraftStorage, {
        businessId: restored.workspace.businessId,
        membershipId: restored.workspace.membershipId,
      });
      setSession({ token, viewer: restored.viewer, workspace: restored.workspace });
    }
    setReady(true);
    setRestoring(false);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await restoreSession();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function expireSession() {
    await clearSessionToken();
    setJobId(null);
    setTimeCardsOpen(false);
    setSession(null);
  }

  async function signOut() {
    if (session) {
      await signOutNative(session.token);
    }
    await clearAllChecklistDrafts(secureChecklistDraftStorage);
    await clearAllTimeCardDrafts(secureTimeCardDraftStorage);
    await expireSession();
  }

  if (!ready || restoring) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color="#86efac" />
        <StatusBar style="light" />
      </View>
    );
  }

  if (restoreError) {
    return (
      <View style={styles.boot}>
        <Text style={styles.restoreError}>{restoreError}</Text>
        <Pressable
          onPress={() => {
            void restoreSession();
          }}
          style={styles.retry}
        >
          <Text style={styles.retryLabel}>Retry</Text>
        </Pressable>
        <StatusBar style="light" />
      </View>
    );
  }

  if (!session) {
    return (
      <>
        <SignInScreen onSignedIn={setSession} />
        <StatusBar style="light" />
      </>
    );
  }

  if (jobId) {
    return (
      <>
        <JobScreen
          jobId={jobId}
          onBack={() => setJobId(null)}
          onSessionExpired={() => {
            void expireSession();
          }}
          token={session.token}
          workspace={session.workspace}
        />
        <StatusBar style="light" />
      </>
    );
  }

  if (timeCardsOpen) {
    return (
      <>
        <TimeCardsScreen
          onBack={() => setTimeCardsOpen(false)}
          onSessionExpired={() => {
            void expireSession();
          }}
          token={session.token}
          workspace={session.workspace}
        />
        <StatusBar style="light" />
      </>
    );
  }

  return (
    <>
      <TodayScreen
        onOpenJob={setJobId}
        onOpenTimeCards={() => setTimeCardsOpen(true)}
        onSessionExpired={() => {
          void expireSession();
        }}
        onSignOut={() => {
          void signOut();
        }}
        token={session.token}
        viewer={session.viewer}
        workspace={session.workspace}
      />
      <StatusBar style="light" />
    </>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#111827",
    padding: 24,
    gap: 16,
  },
  restoreError: {
    color: "#fca5a5",
    textAlign: "center",
  },
  retry: {
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  retryLabel: {
    color: "#f9fafb",
    fontWeight: "700",
  },
});
