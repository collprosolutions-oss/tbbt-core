import { nativeApiUrl } from "./config";
import type {
  NativeFieldActivityType,
  NativeJobDetail,
  NativeJobPhotoAuthorizePayload,
  NativeJobPhotoStage,
  NativeJobProblemKind,
  NativePickupException,
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
    return {
      error: typeof body.error === "string" ? body.error : "Session expired.",
      status: response.status,
    };
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

export async function loadNativeTimeCards(
  token: string,
): Promise<NativeTimeCardsPayload | NativeApiError> {
  const response = await fetch(nativeApiUrl("/api/native/v1/time-cards"), {
    headers: authHeaders(token),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "Time cards are not available." };
  }
  return body as unknown as NativeTimeCardsPayload;
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
  const response = await fetch(nativeApiUrl("/api/native/v1/time-cards/corrections"), {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const body = await parseJson(response);
  if (!response.ok) {
    return {
      error: typeof body.error === "string" ? body.error : "That correction could not be requested.",
    };
  }
  return body as unknown as {
    timeCards: NativeTimeCardsPayload;
    request: { id: string; status: string; timeEntryId: string };
    message: string;
  };
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

export async function startNativeJob(
  token: string,
  jobId: string,
): Promise<
  | { job: NativeJobDetail; alreadyStarted: boolean; alreadyRunningTime: boolean }
  | NativeApiError
> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/start`),
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "That job could not be started." };
  }
  return body as unknown as {
    job: NativeJobDetail;
    alreadyStarted: boolean;
    alreadyRunningTime: boolean;
  };
}

export async function stopNativeJobRunningTime(
  token: string,
  jobId: string,
): Promise<{ job: NativeJobDetail; alreadyStopped: boolean } | NativeApiError> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/stop-time`),
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "That job time could not be stopped." };
  }
  return body as unknown as { job: NativeJobDetail; alreadyStopped: boolean };
}

export async function startNativeActivityTime(
  token: string,
  jobId: string,
  activityType: NativeFieldActivityType,
): Promise<
  | { job: NativeJobDetail; alreadyStarted: boolean; alreadyRunningTime: boolean }
  | NativeApiError
> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/start-activity`),
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ activityType }),
    },
  );
  const body = await parseJson(response);
  if (!response.ok) {
    return {
      error:
        typeof body.error === "string" ? body.error : "That time could not be started.",
    };
  }
  return body as unknown as {
    job: NativeJobDetail;
    alreadyStarted: boolean;
    alreadyRunningTime: boolean;
  };
}

export async function stopNativeActivityTime(
  token: string,
  jobId: string,
  activityType: NativeFieldActivityType,
): Promise<{ job: NativeJobDetail; alreadyStopped: boolean } | NativeApiError> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/stop-activity`),
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ activityType }),
    },
  );
  const body = await parseJson(response);
  if (!response.ok) {
    return {
      error:
        typeof body.error === "string" ? body.error : "That time could not be stopped.",
    };
  }
  return body as unknown as { job: NativeJobDetail; alreadyStopped: boolean };
}

export async function completeNativeJob(
  token: string,
  jobId: string,
): Promise<{ job: NativeJobDetail; alreadyCompleted: boolean } | NativeApiError> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/complete`),
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const body = await parseJson(response);
  if (!response.ok) {
    return { error: typeof body.error === "string" ? body.error : "That job could not be completed." };
  }
  return body as unknown as { job: NativeJobDetail; alreadyCompleted: boolean };
}

export const NATIVE_CHECKLIST_OFFLINE_MESSAGE =
  "Couldn't reach the server — your changes are still saved on this phone.";

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
    };
  }
  return body as unknown as { job: NativeJobDetail; alreadyRecorded: boolean };
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
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/pickup`),
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
          : "That pickup item could not be recorded.",
    };
  }
  return body as unknown as { job: NativeJobDetail; alreadyRecorded: boolean };
}

export async function recordNativeJobVisit(
  token: string,
  jobId: string,
  outcomeStatus: NativeVisitOutcomeStatus,
): Promise<{ job: NativeJobDetail; alreadyRecorded: boolean } | NativeApiError> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/visit`),
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ outcomeStatus }),
    },
  );
  const body = await parseJson(response);
  if (!response.ok) {
    return {
      error: typeof body.error === "string" ? body.error : "That visit outcome could not be recorded.",
    };
  }
  return body as unknown as { job: NativeJobDetail; alreadyRecorded: boolean };
}

export async function authorizeNativeJobPhoto(
  token: string,
  jobId: string,
  input: { originalFilename: string; mimeType: string; fileSizeBytes: number },
): Promise<NativeJobPhotoAuthorizePayload | NativeApiError> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/photos/authorize`),
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
    return { error: typeof body.error === "string" ? body.error : "That photo could not be uploaded. Try again." };
  }
  return body as unknown as NativeJobPhotoAuthorizePayload;
}

export async function finalizeNativeJobPhoto(
  token: string,
  jobId: string,
  input: { assetId: string; stage: NativeJobPhotoStage; caption?: string },
): Promise<{ job: NativeJobDetail } | NativeApiError> {
  const response = await fetch(
    nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/photos/finalize`),
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
    return { error: typeof body.error === "string" ? body.error : "That photo could not be uploaded. Try again." };
  }
  return body as unknown as { job: NativeJobDetail };
}

export async function abortNativeJobPhoto(
  token: string,
  jobId: string,
  assetId: string,
) {
  await fetch(nativeApiUrl(`/api/native/v1/jobs/${encodeURIComponent(jobId)}/photos/abort`), {
    method: "POST",
    headers: {
      ...authHeaders(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ assetId }),
  }).catch(() => undefined);
}

export function isApiError(value: unknown): value is NativeApiError {
  return Boolean(value && typeof value === "object" && "error" in value && typeof (value as NativeApiError).error === "string");
}
