import { nativeApiUrl } from "./config";
import { isLostAssignment, isSessionExpired } from "./recovery";
import type {
  NativeFieldActivityType,
  NativeJobDetail,
  NativeJobPhotoAuthorizePayload,
  NativeJobPhotoStage,
  NativeJobProblemKind,
  NativePickupException,
  NativePushPreferencePayload,
  NativeSessionPayload,
  NativeTimeCardsPayload,
  NativeTodayPayload,
  NativeViewer,
  NativeVisitOutcomeStatus,
  NativeWorkspace,
} from "./types";

export type NativeApiError = {
  error: string;
  status?: number;
  totpRequired?: boolean;
  challengeToken?: string;
};

export const NATIVE_NETWORK_ERROR =
  "Couldn't reach the server. Check your connection and try again.";

export const NATIVE_CHECKLIST_OFFLINE_MESSAGE =
  "Couldn't reach the server — your changes are still saved on this phone.";

export const NATIVE_TIME_CARD_OFFLINE_MESSAGE =
  "Couldn't reach the server — your start or stop is still saved on this phone.";

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

function jsonHeaders(token?: string | null): Record<string, string> {
  return {
    ...authHeaders(token),
    "Content-Type": "application/json",
  };
}

export async function requestNativeJson<T>(
  path: string,
  init: RequestInit,
  fallbackError: string,
  networkError = NATIVE_NETWORK_ERROR,
): Promise<T | NativeApiError> {
  try {
    const response = await fetch(nativeApiUrl(path), init);
    const body = await parseJson(response);
    if (!response.ok) {
      return {
        error: typeof body.error === "string" ? body.error : fallbackError,
        status: response.status,
        totpRequired: body.totpRequired === true,
        challengeToken:
          typeof body.challengeToken === "string" ? body.challengeToken : undefined,
      };
    }
    return body as T;
  } catch {
    return { error: networkError };
  }
}

export { isLostAssignment, isSessionExpired };

export function isNativeNetworkError(value: NativeApiError) {
  return value.status == null && value.error === NATIVE_NETWORK_ERROR;
}

export async function signInNative(input: {
  email: string;
  password: string;
  challengeToken?: string;
  totpCode?: string;
}): Promise<NativeSessionPayload | NativeApiError> {
  return requestNativeJson<NativeSessionPayload>(
    "/api/native/v1/session",
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        challengeToken: input.challengeToken,
        totpCode: input.totpCode,
      }),
    },
    "Sign in failed.",
  );
}

export async function loadNativeSession(token: string): Promise<
  | { viewer: NativeViewer; workspace: NativeWorkspace }
  | NativeApiError
> {
  return requestNativeJson<{ viewer: NativeViewer; workspace: NativeWorkspace }>(
    "/api/native/v1/session",
    {
      headers: authHeaders(token),
    },
    "Session expired.",
  );
}

export async function signOutNative(token: string) {
  await fetch(nativeApiUrl("/api/native/v1/session"), {
    method: "DELETE",
    headers: authHeaders(token),
  }).catch(() => undefined);
}

export async function loadNativePushPreference(
  token: string,
): Promise<NativePushPreferencePayload | NativeApiError> {
  return requestNativeJson<NativePushPreferencePayload>(
    "/api/native/v1/push-devices",
    {
      headers: authHeaders(token),
    },
    "Job alerts are not available.",
  );
}

export async function registerNativePushDevice(
  token: string,
  input: { token: string; platform: "ios" | "android" | "expo" | "test"; optedIn: boolean },
): Promise<NativePushPreferencePayload | NativeApiError> {
  return requestNativeJson<NativePushPreferencePayload>(
    "/api/native/v1/push-devices",
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
    "Job alerts could not be updated.",
  );
}

export async function revokeNativePushDevice(
  token: string,
  deviceToken: string,
): Promise<NativePushPreferencePayload | NativeApiError> {
  return requestNativeJson<NativePushPreferencePayload>(
    "/api/native/v1/push-devices",
    {
      method: "DELETE",
      headers: jsonHeaders(token),
      body: JSON.stringify({ token: deviceToken }),
    },
    "Job alerts could not be updated.",
  );
}

export async function loadNativeToday(token: string): Promise<NativeTodayPayload | NativeApiError> {
  return requestNativeJson<NativeTodayPayload>(
    "/api/native/v1/today",
    {
      headers: authHeaders(token),
    },
    "Today is not available.",
  );
}

export async function loadNativeTimeCards(
  token: string,
): Promise<NativeTimeCardsPayload | NativeApiError> {
  return requestNativeJson<NativeTimeCardsPayload>(
    "/api/native/v1/time-cards",
    {
      headers: authHeaders(token),
    },
    "Time cards are not available.",
  );
}

export async function requestNativeTimeCorrection(
  token: string,
  input: {
    timeEntryId: string;
    reason: string;
    proposedStartDate: string;
    proposedStartTime: string;
    proposedEndDate: string;
    proposedEndTime: string;
  },
): Promise<
  | { timeCards: NativeTimeCardsPayload; request: { id: string; status: string; timeEntryId: string }; message: string }
  | NativeApiError
> {
  return requestNativeJson(
    "/api/native/v1/time-cards/corrections",
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
    "That correction could not be requested.",
  );
}

export async function loadNativeJob(
  token: string,
  jobId: string,
): Promise<{ job: NativeJobDetail } | NativeApiError> {
  return requestNativeJson<{ job: NativeJobDetail }>(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}`,
    {
      headers: authHeaders(token),
    },
    "That job is not available.",
  );
}

export async function startNativeJob(
  token: string,
  jobId: string,
): Promise<
  | { job: NativeJobDetail; alreadyStarted: boolean; alreadyRunningTime: boolean }
  | NativeApiError
> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/start`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    },
    "That job could not be started.",
  );
}

export async function stopNativeJobRunningTime(
  token: string,
  jobId: string,
): Promise<{ job: NativeJobDetail; alreadyStopped: boolean } | NativeApiError> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/stop-time`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    },
    "That job time could not be stopped.",
  );
}

export async function startNativeActivityTime(
  token: string,
  jobId: string,
  activityType: NativeFieldActivityType,
): Promise<
  | { job: NativeJobDetail; alreadyStarted: boolean; alreadyRunningTime: boolean }
  | NativeApiError
> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/start-activity`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ activityType }),
    },
    "That time could not be started.",
  );
}

export async function stopNativeActivityTime(
  token: string,
  jobId: string,
  activityType: NativeFieldActivityType,
): Promise<{ job: NativeJobDetail; alreadyStopped: boolean } | NativeApiError> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/stop-activity`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ activityType }),
    },
    "That time could not be stopped.",
  );
}

export async function syncNativeJobTimeDraft(
  token: string,
  jobId: string,
  input: {
    expectedFingerprint: string;
    intents: Array<{ action: string; intendedAt: string }>;
  },
): Promise<{ job: NativeJobDetail; alreadySynced: boolean } | NativeApiError> {
  try {
    const response = await fetch(
      nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/time/sync`),
      {
        method: "POST",
        headers: {
          ...authHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    const body = await parseJson(response);
    if (!response.ok) {
      return {
        error:
          typeof body.error === "string"
            ? body.error
            : "Those time-card changes could not be synced.",
        status: response.status,
      };
    }
    return body as unknown as { job: NativeJobDetail; alreadySynced: boolean };
  } catch {
    return { error: NATIVE_TIME_CARD_OFFLINE_MESSAGE };
  }
}

export async function completeNativeJob(
  token: string,
  jobId: string,
): Promise<{ job: NativeJobDetail; alreadyCompleted: boolean } | NativeApiError> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/complete`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    },
    "That job could not be completed.",
  );
}

export async function syncNativeJobChecklistDraft(
  token: string,
  jobId: string,
  input: {
    expectedFingerprint: string;
    items: Array<{ itemKey: string; checked: boolean; baseChecked: boolean }>;
  },
): Promise<{ job: NativeJobDetail; alreadySynced: boolean } | NativeApiError> {
  try {
    const response = await fetch(
      nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/checklist/sync`),
      {
        method: "POST",
        headers: {
          ...authHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    const body = await parseJson(response);
    if (!response.ok) {
      return {
        error:
          typeof body.error === "string"
            ? body.error
            : "Those checklist changes could not be synced.",
        status: response.status,
      };
    }
    return body as unknown as { job: NativeJobDetail; alreadySynced: boolean };
  } catch {
    return { error: NATIVE_CHECKLIST_OFFLINE_MESSAGE };
  }
}

export async function recordNativeJobProblem(
  token: string,
  jobId: string,
  input: {
    kind: NativeJobProblemKind;
    description: string;
  },
): Promise<{ job: NativeJobDetail; alreadyRecorded: boolean } | NativeApiError> {
  try {
    const response = await fetch(
      nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/problem`),
      {
        method: "POST",
        headers: {
          ...authHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    const body = await parseJson(response);
    if (!response.ok) {
      return {
        error:
          typeof body.error === "string"
            ? body.error
            : "That problem report could not be recorded.",
        status: response.status,
      };
    }
    return body as unknown as { job: NativeJobDetail; alreadyRecorded: boolean };
  } catch {
    return { error: "Couldn't reach the server." };
  }
}

export async function recordNativeJobPickupItem(
  token: string,
  jobId: string,
  input: {
    itemId: string;
    quantityPickedUp?: string | null;
    pickupException?: NativePickupException | null;
    pickupExceptionNote?: string | null;
  },
): Promise<{ job: NativeJobDetail; alreadyRecorded: boolean } | NativeApiError> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/pickup`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
    "That pickup item could not be recorded.",
  );
}

export async function recordNativeJobVisit(
  token: string,
  jobId: string,
  outcomeStatus: NativeVisitOutcomeStatus,
): Promise<{ job: NativeJobDetail; alreadyRecorded: boolean } | NativeApiError> {
  return requestNativeJson(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/visit`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ outcomeStatus }),
    },
    "That visit outcome could not be recorded.",
  );
}

export async function authorizeNativeJobPhoto(
  token: string,
  jobId: string,
  input: { originalFilename: string; mimeType: string; fileSizeBytes: number },
): Promise<NativeJobPhotoAuthorizePayload | NativeApiError> {
  return requestNativeJson<NativeJobPhotoAuthorizePayload>(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/photos/authorize`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
    "That photo could not be uploaded. Try again.",
  );
}

export async function finalizeNativeJobPhoto(
  token: string,
  jobId: string,
  input: { assetId: string; stage: NativeJobPhotoStage; caption?: string },
): Promise<{ job: NativeJobDetail } | NativeApiError> {
  return requestNativeJson<{ job: NativeJobDetail }>(
    `/api/native/v1/jobs/${encodeURIComponent(jobId)}/photos/finalize`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(input),
    },
    "That photo could not be uploaded. Try again.",
  );
}

export async function abortNativeJobPhoto(
  token: string,
  jobId: string,
  assetId: string,
) {
  await fetch(nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/photos/abort`), {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ assetId }),
  }).catch(() => undefined);
}

export function isApiError(value: unknown): value is NativeApiError {
  return Boolean(value && typeof value === "object" && "error" in value && typeof (value as NativeApiError).error === "string");
}
