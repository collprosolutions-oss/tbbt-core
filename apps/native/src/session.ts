import * as SecureStore from "expo-secure-store";
import { readExpoPushToken, requestNativeJobAlertPermission } from "./push-token";
import {
  resolveNativePushOptInToken,
  type NativePushDeviceTokenResult,
} from "./push-token-resolve";

const TOKEN_KEY = "tbbt.native.session.token";
const DEVICE_TOKEN_KEY = "tbbt.native.push.device-token";

export async function readSessionToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function writeSessionToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearSessionToken() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export async function readOptInNativePushDeviceToken(options?: {
  requestPermission?: boolean;
}): Promise<NativePushDeviceTokenResult> {
  const requirePermission = options?.requestPermission === true;
  const permissionGranted = requirePermission ? await requestNativeJobAlertPermission() : true;
  const expoToken = await readExpoPushToken();
  const storedToken = await readNativePushDeviceToken();
  const resolved = resolveNativePushOptInToken({
    permissionGranted,
    expoToken,
    storedToken,
    requirePermission,
  });
  if (resolved.ok) {
    await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, resolved.token);
  }
  return resolved;
}

export async function readNativePushDeviceToken() {
  return SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
}

export async function clearNativePushDeviceToken() {
  await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
}
