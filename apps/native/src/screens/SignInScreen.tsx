import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { NativeBuildStamp } from "./NativeBuildStamp";
import { isApiError, signInNative } from "../api";
import { secureChecklistDraftStorage } from "../checklist-draft-storage";
import { applyChecklistDraftAccount } from "../checklist-drafts";
import { secureTimeCardDraftStorage } from "../time-card-draft-storage";
import { applyTimeCardDraftAccount } from "../time-card-drafts";
import { writeSessionToken } from "../session";
import type { NativeViewer, NativeWorkspace } from "../types";

export function SignInScreen({
  onSignedIn,
}: {
  onSignedIn: (input: { token: string; viewer: NativeViewer; workspace: NativeWorkspace }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await signInNative({
        email,
        password,
        challengeToken: challengeToken ?? undefined,
        totpCode,
      });
      if (isApiError(result)) {
        setChallengeToken(result.challengeToken ?? null);
        setError(result.error);
        return;
      }
      await applyChecklistDraftAccount(secureChecklistDraftStorage, {
        businessId: result.workspace.businessId,
        membershipId: result.workspace.membershipId,
      });
      await applyTimeCardDraftAccount(secureTimeCardDraftStorage, {
        businessId: result.workspace.businessId,
        membershipId: result.workspace.membershipId,
      });
      await writeSessionToken(result.session.token);
      onSignedIn({
        token: result.session.token,
        viewer: result.viewer,
        workspace: result.workspace,
      });
    } catch {
      setError("Could not reach TBBT. Check the API URL.");
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <View style={styles.card}>
      <Text style={styles.kicker}>TBBT Field</Text>
      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.copy}>
        Assigned jobs only. Your password stays on the server; this app stores a session token.
      </Text>
      <TextInput
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        importantForAutofill="yes"
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor="#8b94a7"
        style={styles.input}
        value={email}
      />
      <TextInput
        autoCapitalize="none"
        autoComplete="password"
        importantForAutofill="yes"
        onChangeText={setPassword}
        placeholder="Password"
        placeholderTextColor="#8b94a7"
        secureTextEntry
        style={styles.input}
        value={password}
      />
      {challengeToken ? (
        <TextInput
          autoCapitalize="none"
          keyboardType="number-pad"
          onChangeText={setTotpCode}
          placeholder="Authenticator code"
          placeholderTextColor="#8b94a7"
          style={styles.input}
          value={totpCode}
        />
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable disabled={busy} onPress={submit} style={styles.button}>
        {busy ? <ActivityIndicator color="#102018" /> : <Text style={styles.buttonLabel}>Continue</Text>}
      </Pressable>
      <NativeBuildStamp />
    </View>
  );

  if (Platform.OS === "android") {
    return (
      <ScrollView
        contentContainerStyle={styles.screen}
        keyboardShouldPersistTaps="handled"
        style={styles.androidScroll}
      >
        {form}
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      {form}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  androidScroll: {
    flex: 1,
    backgroundColor: "#111827",
  },
  screen: {
    flexGrow: 1,
    backgroundColor: "#111827",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "#1f2937",
    borderRadius: 20,
    padding: 24,
    gap: 12,
  },
  kicker: {
    color: "#86efac",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  title: {
    color: "#f9fafb",
    fontSize: 28,
    fontWeight: "700",
  },
  copy: {
    color: "#d1d5db",
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    backgroundColor: "#111827",
    borderColor: "#374151",
    borderRadius: 12,
    borderWidth: 1,
    color: "#f9fafb",
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  error: {
    color: "#fca5a5",
    fontSize: 14,
  },
  button: {
    alignItems: "center",
    backgroundColor: "#86efac",
    borderRadius: 12,
    paddingVertical: 14,
  },
  buttonLabel: {
    color: "#102018",
    fontSize: 16,
    fontWeight: "700",
  },
});
