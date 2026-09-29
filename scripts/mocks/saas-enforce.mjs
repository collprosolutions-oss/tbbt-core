import { getTestAccess } from "../estimate-options-test-access.mjs";

export async function requireOperatingBusinessAccess() {
  const access = getTestAccess();
  if (!access) throw new Error("Test access is not configured.");
  return access;
}

export async function requireOperatingBusinessAccessForForm() {
  const access = getTestAccess();
  if (!access) return { ok: false, error: "Test access is not configured." };
  return { ok: true, access };
}

export async function requireOperatingProductAccess() {
  return requireOperatingBusinessAccess();
}

export async function requireOperatingProductAccessForForm() {
  return requireOperatingBusinessAccessForForm();
}
