import { Platform, StyleSheet, Text } from "react-native";
import { nativeBuildStampLabel } from "../android";
import { nativeIosBuildStampLabel } from "../ios";

export function NativeBuildStamp() {
  const label = Platform.OS === "ios" ? nativeIosBuildStampLabel() : nativeBuildStampLabel();
  return <Text style={styles.stamp}>{label}</Text>;
}

const styles = StyleSheet.create({
  stamp: {
    color: "#6b7280",
    fontSize: 12,
    fontWeight: "600",
  },
});
