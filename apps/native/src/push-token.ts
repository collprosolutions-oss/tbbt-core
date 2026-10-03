import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { isExpoPushToken } from "./push-token-resolve";

export { EXPO_PUSH_TOKEN_PATTERN, isExpoPushToken } from "./push-token-resolve";
export const NATIVE_JOB_ALERT_CHANNEL_ID = "job-alerts";

export function jobIdFromNativePushNotification(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.startsTime === true || record.acceptsAppointment === true) return null;
  const jobId = typeof record.jobId === "string" ? record.jobId.trim() : "";
  return jobId || null;
}

export function configureNativeJobAlertHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function ensureAndroidJobAlertChannel() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(NATIVE_JOB_ALERT_CHANNEL_ID, {
    name: "Job alerts",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
  });
}

export async function requestNativeJobAlertPermission() {
  const existing = await Notifications.getPermissionsAsync();
  if (!existing.granted) {
    const next = await Notifications.requestPermissionsAsync();
    if (!next.granted) return false;
  }
  await ensureAndroidJobAlertChannel();
  return true;
}

export async function readExpoPushToken() {
  try {
    const projectId = process.env.EXPO_PUBLIC_PROJECT_ID?.trim();
    const result = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const token = typeof result.data === "string" ? result.data.trim() : "";
    return isExpoPushToken(token) ? token : null;
  } catch {
    return null;
  }
}
