/**
 * Scope / Included Work on estimate, change-order, and invoice lines.
 *
 * This is descriptive text only. persistDraftEstimateTotal,
 * persistDraftChangeOrderTotal, and invoice totals never read it.
 */
export const MAX_INCLUDED_WORK_LENGTH = 8000;

export function normalizeIncludedWork(
  raw: string | null | undefined,
): string | null {
  if (raw == null) {
    return null;
  }
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) {
    return null;
  }
  return text.length > MAX_INCLUDED_WORK_LENGTH
    ? text.slice(0, MAX_INCLUDED_WORK_LENGTH)
    : text;
}

export function includedWorkLines(raw: string | null | undefined): string[] {
  const text = normalizeIncludedWork(raw);
  if (!text) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
