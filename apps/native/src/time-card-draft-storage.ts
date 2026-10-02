import * as SecureStore from "expo-secure-store";
import type { TimeCardDraftStorage } from "./time-card-drafts";

export const secureTimeCardDraftStorage: TimeCardDraftStorage = {
  read(key) {
    return SecureStore.getItemAsync(key);
  },
  write(key, value) {
    return SecureStore.setItemAsync(key, value);
  },
  remove(key) {
    return SecureStore.deleteItemAsync(key);
  },
};
