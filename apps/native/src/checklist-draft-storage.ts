import * as SecureStore from "expo-secure-store";
import type { ChecklistDraftStorage } from "./checklist-drafts";

export const secureChecklistDraftStorage: ChecklistDraftStorage = {
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
