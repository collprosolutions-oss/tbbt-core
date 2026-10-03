import { StyleSheet, Text } from "react-native";
import { nativeBuildStampLabel } from "../android";

export function NativeBuildStamp() {
  return <Text style={styles.stamp}>{nativeBuildStampLabel()}</Text>;
}

const styles = StyleSheet.create({
  stamp: {
    color: "#6b7280",
    fontSize: 12,
    fontWeight: "600",
  },
});
