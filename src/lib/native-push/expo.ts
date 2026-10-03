/**
 * Connected Expo Push adapter.
 *
 * Official send: POST https://exp.host/--/api/v2/push/send
 * Authorization: Bearer EXPO_ACCESS_TOKEN
 *
 * This module never runs in the fake-adapter proofs unless a test
 * injects a fetch stand-in. Tests must not set a real EXPO_ACCESS_TOKEN
 * or call the live Expo host.
 */
import { nativePushPayloadHasForbiddenFields } from "@/lib/native-push/payload";
import {
  EXPO_NATIVE_PUSH_PROVIDER,
  getExpoAccessToken,
} from "@/lib/native-push/config";
import type {
  NativePushAlertPayload,
  NativePushProvider,
  NativePushSendInput,
  NativePushSendResult,
} from "@/lib/native-push/types";

export const EXPO_PUSH_API_ORIGIN = "https://exp.host";
export const EXPO_PUSH_SEND_PATH = "/--/api/v2/push/send";
export const EXPO_PUSH_SEND_URL = `${EXPO_PUSH_API_ORIGIN}${EXPO_PUSH_SEND_PATH}`;
export const EXPO_PUSH_SEND_TIMEOUT_MS = 4_000;
export const EXPO_PUSH_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/;

export type ExpoFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type ExpoNativePushConfig = {
  accessToken: string;
};

export type ExpoNativePushProvider = NativePushProvider & {
  config: ExpoNativePushConfig;
};

export function isExpoPushToken(token: string) {
  return EXPO_PUSH_TOKEN_PATTERN.test(token.trim());
}

export function expoPushMessageFromAlert(input: NativePushSendInput) {
  return {
    to: input.deviceToken,
    title: input.payload.title,
    body: input.payload.body,
    sound: "default" as const,
    channelId: "job-alerts",
    data: {
      kind: input.payload.kind,
      jobId: input.payload.jobId,
      informational: true as const,
      startsTime: false as const,
      acceptsAppointment: false as const,
    },
  };
}

function safePayload(payload: NativePushAlertPayload): NativePushAlertPayload {
  return {
    kind: payload.kind,
    jobId: payload.jobId,
    title: payload.title,
    body: payload.body,
    informational: true,
    startsTime: false,
    acceptsAppointment: false,
  };
}

function ticketError(ticket: Record<string, unknown>) {
  const message = typeof ticket.message === "string" ? ticket.message : "";
  const details = ticket.details;
  const code =
    details && typeof details === "object" && !Array.isArray(details)
      ? typeof (details as { error?: unknown }).error === "string"
        ? (details as { error: string }).error
        : ""
      : "";
  if (code === "DeviceNotRegistered") {
    return "Expo reported the device token is no longer registered.";
  }
  return message || "Expo rejected the alert.";
}

export function createExpoNativePushProvider(
  config: ExpoNativePushConfig = { accessToken: getExpoAccessToken() ?? "" },
  fetchImpl: ExpoFetch = fetch as ExpoFetch,
): ExpoNativePushProvider {
  return {
    id: EXPO_NATIVE_PUSH_PROVIDER,
    connected: true,
    config,
    async send(input: NativePushSendInput): Promise<NativePushSendResult> {
      if (!config.accessToken) {
        return {
          ok: false,
          status: "FAILED",
          error: "Expo push is not configured.",
        };
      }
      if (nativePushPayloadHasForbiddenFields(input.payload)) {
        return {
          ok: false,
          status: "FAILED",
          error: "Expo push provider refused a payload with forbidden fields.",
        };
      }
      const payload = safePayload(input.payload);
      if (!isExpoPushToken(input.deviceToken)) {
        return {
          ok: false,
          status: "FAILED",
          error: "That device token is not an Expo push token.",
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXPO_PUSH_SEND_TIMEOUT_MS);
      let response: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        response = await fetchImpl(EXPO_PUSH_SEND_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip, deflate",
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([expoPushMessageFromAlert({ ...input, payload })]),
          signal: controller.signal,
        });
      } catch (error) {
        const timedOut =
          (error instanceof Error && error.name === "AbortError") || controller.signal.aborted;
        return {
          ok: false,
          status: "FAILED",
          error: timedOut ? "Expo push timed out." : "Expo push failed.",
        };
      } finally {
        clearTimeout(timer);
      }

      let body: Record<string, unknown> = {};
      try {
        const json = await response.json();
        if (json && typeof json === "object") body = json as Record<string, unknown>;
      } catch {
        body = {};
      }

      const errors = Array.isArray(body.errors) ? body.errors : [];
      if (!response.ok || errors.length > 0) {
        const first = errors[0];
        const message =
          first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string"
            ? (first as { message: string }).message
            : "Expo rejected the alert.";
        return { ok: false, status: "FAILED", error: message };
      }

      const tickets = Array.isArray(body.data) ? body.data : body.data ? [body.data] : [];
      const ticket = tickets[0];
      if (!ticket || typeof ticket !== "object") {
        return { ok: false, status: "FAILED", error: "Expo returned no delivery ticket." };
      }
      const record = ticket as Record<string, unknown>;
      if (record.status === "ok") {
        const id = typeof record.id === "string" ? record.id : "";
        if (!id) {
          return { ok: false, status: "FAILED", error: "Expo returned no delivery ticket." };
        }
        return { ok: true, status: "SENT", providerMessageId: id };
      }
      return { ok: false, status: "FAILED", error: ticketError(record) };
    },
  };
}
