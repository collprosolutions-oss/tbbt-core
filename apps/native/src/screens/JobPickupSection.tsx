import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { isApiError, recordNativeJobPickupItem } from "../api";
import type {
  NativeJobDetail,
  NativeJobPickupItem,
  NativePickupException,
} from "../types";

const EXCEPTIONS: Array<{ value: NativePickupException; label: string }> = [
  { value: "UNAVAILABLE", label: "Unavailable" },
  { value: "SHORT", label: "Short" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "CLOSED", label: "Closed" },
  { value: "OTHER", label: "Other" },
];

type PickupDraft = {
  quantity: string;
  exception: NativePickupException | null;
  note: string;
};

function emptyDraft(item: NativeJobPickupItem): PickupDraft {
  return {
    quantity: item.quantityPickedUp ?? "",
    exception: isPickupException(item.pickupException) ? item.pickupException : null,
    note: item.pickupExceptionNote ?? "",
  };
}

function isPickupException(value: string | null | undefined): value is NativePickupException {
  return EXCEPTIONS.some((item) => item.value === value);
}

export function JobPickupSection({
  token,
  jobId,
  items,
  onJobUpdated,
}: {
  token: string;
  jobId: string;
  items: NativeJobPickupItem[];
  onJobUpdated: (job: NativeJobDetail) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, PickupDraft>>({});
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts((current) => {
      const next: Record<string, PickupDraft> = {};
      for (const item of items) {
        next[item.id] = current[item.id] ?? emptyDraft(item);
      }
      return next;
    });
  }, [items]);

  async function recordItem(item: NativeJobPickupItem) {
    if (pendingItemId) return;
    const draft = drafts[item.id] ?? emptyDraft(item);
    setPendingItemId(item.id);
    setError(null);
    const result = await recordNativeJobPickupItem(token, jobId, {
      itemId: item.id,
      quantityPickedUp: draft.quantity.trim() || null,
      pickupException: draft.exception,
      pickupExceptionNote: draft.note.trim() || null,
    });
    if (isApiError(result)) {
      setPendingItemId(null);
      setError(result.error);
      return;
    }
    onJobUpdated(result.job);
    setPendingItemId(null);
  }

  if (items.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.groupTitle}>Material pickup items</Text>
      <Text style={styles.body}>
        Pickup for this assigned job only. Recording a quantity or exception does
        not purchase the item or start pickup time.
      </Text>
      {items.map((item) => {
        const draft = drafts[item.id] ?? emptyDraft(item);
        return (
          <View key={item.id} style={styles.card}>
            <Text style={styles.name}>
              {item.name} · {item.quantityNeeded} {item.unit}
            </Text>
            <Text style={styles.meta}>
              {item.supplierName ?? "No supplier listed"}
              {item.pickupLocationDescription ? ` · ${item.pickupLocationDescription}` : ""}
            </Text>
            <Text style={styles.meta}>
              {item.pickupReady ? "Ready for pickup" : "Not marked ready"}
              {item.pickupDurationMinutes != null
                ? ` · about ${item.pickupDurationMinutes} min`
                : ""}
            </Text>
            {item.pickupRecorded ? (
              <Text style={styles.recorded}>
                {item.quantityPickedUp
                  ? `Picked up ${item.quantityPickedUp} ${item.unit}`
                  : "Exception recorded"}
                {item.pickupExceptionLabel ? ` · ${item.pickupExceptionLabel}` : ""}
                {item.pickupExceptionNote ? ` · ${item.pickupExceptionNote}` : ""}
              </Text>
            ) : (
              <Text style={styles.meta}>Not recorded yet</Text>
            )}
            <TextInput
              keyboardType="decimal-pad"
              onChangeText={(quantity) => {
                setDrafts((current) => ({
                  ...current,
                  [item.id]: { ...(current[item.id] ?? emptyDraft(item)), quantity },
                }));
              }}
              placeholder="Picked-up quantity"
              placeholderTextColor="#6b7280"
              style={styles.input}
              value={draft.quantity}
            />
            <View style={styles.exceptions}>
              {EXCEPTIONS.map((choice) => {
                const selected = draft.exception === choice.value;
                return (
                  <Pressable
                    key={choice.value}
                    onPress={() => {
                      setDrafts((current) => ({
                        ...current,
                        [item.id]: {
                          ...(current[item.id] ?? emptyDraft(item)),
                          exception: selected ? null : choice.value,
                        },
                      }));
                    }}
                    style={[styles.chip, selected ? styles.chipSelected : null]}
                  >
                    <Text style={styles.chipLabel}>{choice.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            {draft.exception === "OTHER" ? (
              <TextInput
                onChangeText={(note) => {
                  setDrafts((current) => ({
                    ...current,
                    [item.id]: { ...(current[item.id] ?? emptyDraft(item)), note },
                  }));
                }}
                placeholder="Exception note"
                placeholderTextColor="#6b7280"
                style={styles.input}
                value={draft.note}
              />
            ) : null}
            <Pressable
              disabled={pendingItemId != null}
              onPress={() => {
                void recordItem(item);
              }}
              style={[
                styles.action,
                pendingItemId != null ? styles.actionDisabled : null,
              ]}
            >
              <Text style={styles.actionLabel}>
                {pendingItemId === item.id
                  ? "Recording…"
                  : item.pickupRecorded
                    ? "Update pickup record"
                    : "Record pickup"}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
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
  body: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    gap: 8,
    borderColor: "#374151",
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  name: {
    color: "#f9fafb",
    fontSize: 16,
    fontWeight: "700",
  },
  meta: {
    color: "#9ca3af",
    fontSize: 14,
    lineHeight: 20,
  },
  recorded: {
    color: "#86efac",
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    backgroundColor: "#1f2937",
    borderRadius: 10,
    color: "#f9fafb",
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  exceptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    backgroundColor: "#1f2937",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipSelected: {
    backgroundColor: "#166534",
  },
  chipLabel: {
    color: "#f9fafb",
    fontWeight: "600",
  },
  action: {
    alignItems: "center",
    backgroundColor: "#166534",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  actionLabel: {
    color: "#f9fafb",
    fontSize: 16,
    fontWeight: "700",
  },
  error: {
    color: "#fca5a5",
  },
});
