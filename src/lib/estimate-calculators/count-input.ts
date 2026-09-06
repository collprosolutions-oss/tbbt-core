/**
 * Integer quantity helpers for counted calculator inputs.
 * Dimensions, dollar rates, and allowances stay free numeric entry.
 */
export function clampCount(value: unknown, min = 0) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return min;
  return Math.max(min, Math.floor(amount));
}

export function stepCount(current: unknown, delta: number, min = 0) {
  return clampCount(clampCount(current, min) + delta, min);
}

export function parseTypedCount(raw: string, min = 0) {
  if (raw.trim() === "") return min;
  return clampCount(raw, min);
}
