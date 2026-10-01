import { StyleSheet, Text, View } from "react-native";
import type { NativeJobMilestones } from "../types";

export function JobMilestonesSection({
  milestones,
}: {
  milestones: NativeJobMilestones | null | undefined;
}) {
  if (!milestones) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.groupTitle}>Milestones</Text>
      {milestones.items.length === 0 ? (
        <Text style={styles.body}>No recorded milestones on this job.</Text>
      ) : (
        milestones.items.map((milestone, index) => (
          <View key={milestone.id} style={styles.item}>
            <Text style={styles.body}>
              {index + 1}. {milestone.title}
            </Text>
            <Text style={styles.status}>{milestone.statusLabel}</Text>
            <Text style={styles.meta}>
              {milestone.completedAtLabel
                ? `Completed ${milestone.completedAtLabel}`
                : `Recorded ${milestone.recordedAtLabel}`}
            </Text>
          </View>
        ))
      )}
      {milestones.truncatedNotice ? (
        <Text style={styles.notice}>{milestones.truncatedNotice}</Text>
      ) : null}
      <Text style={styles.meta}>Only the owner can mark milestones complete.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
    marginTop: 4,
  },
  groupTitle: {
    color: "#9ca3af",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginTop: 12,
    textTransform: "uppercase",
  },
  item: {
    gap: 2,
  },
  body: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 22,
  },
  status: {
    color: "#86efac",
    fontWeight: "700",
  },
  meta: {
    color: "#d1d5db",
    fontSize: 13,
    lineHeight: 20,
  },
  notice: {
    color: "#fbbf24",
    fontSize: 15,
    lineHeight: 22,
  },
});
