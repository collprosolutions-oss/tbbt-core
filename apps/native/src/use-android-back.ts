import { useEffect } from "react";
import { BackHandler } from "react-native";

/** Android hardware back leaves Job / Time cards instead of exiting the app. */
export function useAndroidHardwareBack(onBack: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onBack();
      return true;
    });
    return () => {
      sub.remove();
    };
  }, [enabled, onBack]);
}
