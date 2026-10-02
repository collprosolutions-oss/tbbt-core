import * as SecureStore from "expo-secure-store";

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

function randomDeviceToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function readOrCreateNativePushDeviceToken() {
  const existing = await SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
  if (existing && existing.length >= 8) return existing;
  const token = randomDeviceToken();
  await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, token);
  return token;
}

export async function readNativePushDeviceToken() {
  return SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
}

export async function clearNativePushDeviceToken() {
  await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
}
