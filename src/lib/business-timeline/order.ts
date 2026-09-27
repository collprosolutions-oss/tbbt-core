import type { BusinessTimelineDraft, BusinessTimelineItem } from "@/lib/business-timeline/types";

function occurredAtValue(item: BusinessTimelineDraft | BusinessTimelineItem): string {
  return item.occurredAt instanceof Date ? item.occurredAt.toISOString() : item.occurredAt;
}

/**
 * Newest first. Equal timestamps use eventType, then id.
 * The comparator is a pure function so the same inputs always sort the same way.
 */
export function compareBusinessTimelineItems(
  left: BusinessTimelineDraft | BusinessTimelineItem,
  right: BusinessTimelineDraft | BusinessTimelineItem,
): number {
  const leftAt = occurredAtValue(left);
  const rightAt = occurredAtValue(right);
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  if (left.eventType !== right.eventType) {
    return left.eventType < right.eventType ? -1 : 1;
  }
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

export function sortBusinessTimelineItems<T extends BusinessTimelineDraft | BusinessTimelineItem>(
  items: T[],
): T[] {
  return [...items].sort(compareBusinessTimelineItems);
}
