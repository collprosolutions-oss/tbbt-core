/**
 * Scope / Included Work on estimate, change-order, and invoice lines.
 *
 * Preview shares the Production database and does not run migrations, so
 * this cannot live in a new Prisma column. Scope is stored in the existing
 * LineItem / EstimateVersionLineItem `description` after a stable marker.
 * Totals never read it.
 */
export const MAX_INCLUDED_WORK_LENGTH = 8000;
export const INCLUDED_WORK_MARKER = "\n\nScope / Included Work:\n";

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

export function splitLineDescription(description: string | null | undefined): {
  title: string;
  includedWork: string | null;
} {
  const raw = description ?? "";
  const index = raw.indexOf(INCLUDED_WORK_MARKER);
  if (index === -1) {
    return { title: raw, includedWork: null };
  }
  return {
    title: raw.slice(0, index),
    includedWork: normalizeIncludedWork(raw.slice(index + INCLUDED_WORK_MARKER.length)),
  };
}

export function lineItemTitle(description: string | null | undefined): string {
  return splitLineDescription(description).title;
}

export function lineItemIncludedWork(
  description: string | null | undefined,
): string | null {
  return splitLineDescription(description).includedWork;
}

export function joinLineDescription(
  title: string,
  includedWork?: string | null,
): string {
  const cleanTitle = splitLineDescription(title).title;
  const scope = normalizeIncludedWork(includedWork);
  if (!scope) {
    return cleanTitle;
  }
  return `${cleanTitle}${INCLUDED_WORK_MARKER}${scope}`;
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
