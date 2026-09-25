export function takeoffSourceKey(lineItemId: string, takeoffItemId: string) {
  return `takeoff:${lineItemId}:${takeoffItemId}`;
}

export function materialLineSourceKey(lineItemId: string) {
  return `material-line:${lineItemId}`;
}

export function isConvertedSourceKey(value: string | null | undefined) {
  return Boolean(value && (value.startsWith("takeoff:") || value.startsWith("material-line:")));
}
