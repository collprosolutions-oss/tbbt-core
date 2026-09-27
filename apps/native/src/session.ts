import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "tbbt.native.session.token";

export async function readSessionToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function writeSessionToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearSessionToken() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
