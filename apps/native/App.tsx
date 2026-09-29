import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { isApiError, loadNativeSession, signOutNative } from "./src/api";
import { JobScreen } from "./src/screens/JobScreen";
import { SignInScreen } from "./src/screens/SignInScreen";
import { TodayScreen } from "./src/screens/TodayScreen";
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await readSessionToken();
      if (!token) {
        if (!cancelled) setReady(true);
        return;
      }
      const restored = await loadNativeSession(token);
      if (cancelled) return;
      if (isApiError(restored)) {
        await clearSessionToken();
      } else {
        setSession({ token, viewer: restored.viewer, workspace: restored.workspace });
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    if (session) {
      await signOutNative(session.token);
    }
    await clearSessionToken();
    setJobId(null);
    setSession(null);
  }

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color="#86efac" />
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
  },
});
