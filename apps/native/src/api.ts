import { nativeApiUrl } from "./config";
import type {
  NativeJobDetail,
  NativeSessionPayload,
  NativeTodayPayload,
  NativeViewer,
  NativeWorkspace,
} from "./types";

export type NativeApiError = {
  error: string;
  totpRequired?: boolean;
  challengeToken?: string;
};

async function parseJson(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: "The server returned an unexpected response." };
  }
}

function authHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function signInNative(input: {
  email: string;
  password: string;
  challengeToken?: string;
  totpCode?: string;
}): Promise<NativeSessionPayload | NativeApiError> {
  const response = await fetch(nativeApiUrl("/api/native/v1/session"), {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      challengeToken: input.challengeToken,
      totpCode: input.totpCode,
    }),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return {
      error: typeof body.error === "string" ? body.error : "Sign in failed.",
      totpRequired: body.totpRequired === true,
      challengeToken: typeof body.challengeToken === "string" ? body.challengeToken : undefined,
    };
  }
  return body as unknown as NativeSessionPayload;
}

export async function loadNativeSession(token: string): Promise<
  | { viewer: NativeViewer; workspace: NativeWorkspace }
  | NativeApiError
> {
  const response = await fetch(nativeApiUrl("/api/native/v1/session"), {
    headers: authHeaders(token),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "Session expired." };
  }
  return body as { viewer: NativeViewer; workspace: NativeWorkspace };
}

export async function signOutNative(token: string) {
  await fetch(nativeApiUrl("/api/native/v1/session"), {
    method: "DELETE",
    headers: authHeaders(token),
  }).catch(() => undefined);
}

export async function loadNativeToday(token: string): Promise<NativeTodayPayload | NativeApiError> {
  const response = await fetch(nativeApiUrl("/api/native/v1/today"), {
    headers: authHeaders(token),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "Today is not available." };
  }
  return body as unknown as NativeTodayPayload;
}

export async function loadNativeJob(
  token: string,
  jobId: string,
): Promise<{ job: NativeJobDetail } | NativeApiError> {
  const response = await fetch(nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}`), {
    headers: authHeaders(token),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "That job is not available." };
  }
  return body as unknown as { job: NativeJobDetail };
}

export function isApiError(value: unknown): value is NativeApiError {
  return Boolean(value && typeof value === "object" && "error" in value && typeof (value as NativeApiError).error === "string");
}
