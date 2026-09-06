/**
 * Public request submit helpers shared by the server action and tests.
 *
 * The customer form must always leave SUBMITTING, including when the
 * server action throws a non-serializable error.
 */
export const PUBLIC_INTAKE_SUBMIT_ERROR =
  "This request could not be submitted. Please try again.";

export type PublicIntakeSubmitResult = { error?: string; ok?: boolean };

export function readFormStrings(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function submitPublicIntakeForm(
  submit: (slug: string, formData: FormData) => Promise<PublicIntakeSubmitResult>,
  slug: string,
  formData: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await submit(slug, formData);
    if (result?.error) return { ok: false, error: result.error };
    if (result?.ok) return { ok: true };
    return { ok: false, error: PUBLIC_INTAKE_SUBMIT_ERROR };
  } catch {
    return { ok: false, error: PUBLIC_INTAKE_SUBMIT_ERROR };
  }
}

export async function runPublicRequestSubmit<T>(
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await work() };
  } catch {
    return { ok: false, error: PUBLIC_INTAKE_SUBMIT_ERROR };
  }
}
