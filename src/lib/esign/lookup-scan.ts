/**
 * Read-only signature-request list scan. Used by the Dropbox Sign adapter
 * and the fake adapter. Never creates a request.
 *
 * "not_found_complete" is allowed only after every page was fetched
 * successfully and the provider reported a total page count that this
 * scan covered. A page cap, timeout, error, malformed page, or unknown
 * total is "unknown" — never a safe "not found".
 *
 * First match on a fetched page wins and stops the scan. A duplicate
 * match on a later unfetched page is not observed.
 */
import type {
  EsignRequestMetadata,
  EsignSignatureLookupOutcome,
  EsignSignatureLookupResult,
  LookupEsignSignatureRequestInput,
} from "@/lib/esign/types";

export const ESIGN_LIST_PAGE_SIZE = 100;
export const ESIGN_LIST_PAGE_LIMIT = 20;
export const ESIGN_LIST_SCAN_BUDGET_MS = 8_000;
export const ESIGN_LIST_PER_REQUEST_CAP_MS = 8_000;

export type EsignListPageFetch =
  | {
      ok: true;
      signatureRequests: unknown[];
      numPages: number;
    }
  | {
      ok: false;
      reason: "error" | "timeout" | "malformed" | "unknown_total";
    };

export type EsignListPageFetchContext = {
  remainingMs: number;
  timeoutMs: number;
  signal: AbortSignal;
};

export function emptyEsignMetadata(): EsignRequestMetadata {
  return {
    businessId: "",
    agreementId: "",
    versionId: "",
    attemptKey: "",
    actorMembershipId: "",
  };
}

export function readEsignLookupRow(value: unknown): EsignSignatureLookupResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    signature_request_id?: unknown;
    requestId?: unknown;
    metadata?: unknown;
  };
  const requestId =
    typeof record.signature_request_id === "string"
      ? record.signature_request_id
      : typeof record.requestId === "string"
        ? record.requestId
        : "";
  if (!requestId) return null;
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") {
    return { requestId, metadata: emptyEsignMetadata() };
  }
  const fields = metadata as Record<string, unknown>;
  return {
    requestId,
    metadata: {
      businessId: typeof fields.businessId === "string" ? fields.businessId : "",
      agreementId: typeof fields.agreementId === "string" ? fields.agreementId : "",
      versionId: typeof fields.versionId === "string" ? fields.versionId : "",
      attemptKey: typeof fields.attemptKey === "string" ? fields.attemptKey : "",
      actorMembershipId:
        typeof fields.actorMembershipId === "string" ? fields.actorMembershipId : "",
    },
  };
}

export function esignLookupRowMatches(
  result: EsignSignatureLookupResult,
  query: LookupEsignSignatureRequestInput,
) {
  return (
    result.metadata.businessId === query.businessId &&
    result.metadata.agreementId === query.agreementId &&
    result.metadata.versionId === query.versionId &&
    result.metadata.attemptKey === query.attemptKey
  );
}

export function remainingLookupBudgetMs(
  startedAt: number,
  budgetMs: number,
  now: () => number,
) {
  return budgetMs - (now() - startedAt);
}

export function lookupRequestTimeoutMs(remainingMs: number, perRequestCapMs: number) {
  return Math.max(1, Math.min(remainingMs, perRequestCapMs));
}

export function isLookupAbortError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Decision after the page walker hits its fetch limit without a match.
 * A remaining page past the cap is unknown:page_cap — never not-found.
 */
export function decideListScanAfterPageLimit(input: {
  lastNumPages: number | null;
  pageLimit: number;
}): EsignSignatureLookupOutcome {
  if (input.lastNumPages != null && input.lastNumPages > input.pageLimit) {
    return { status: "unknown", reason: "page_cap" };
  }
  return { status: "unknown", reason: "unknown_total" };
}

export async function scanEsignSignatureRequestPages(input: {
  fetchPage: (
    page: number,
    context: EsignListPageFetchContext,
  ) => Promise<EsignListPageFetch>;
  query: LookupEsignSignatureRequestInput;
  pageLimit?: number;
  budgetMs?: number;
  perRequestCapMs?: number;
  now?: () => number;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
}): Promise<EsignSignatureLookupOutcome> {
  const pageLimit = input.pageLimit ?? ESIGN_LIST_PAGE_LIMIT;
  const budgetMs = input.budgetMs ?? ESIGN_LIST_SCAN_BUDGET_MS;
  const perRequestCapMs = input.perRequestCapMs ?? ESIGN_LIST_PER_REQUEST_CAP_MS;
  const now = input.now ?? Date.now;
  const createTimeoutSignal = input.createTimeoutSignal ?? ((timeoutMs: number) =>
    AbortSignal.timeout(timeoutMs));
  const started = now();
  const matches: EsignSignatureLookupResult[] = [];
  let lastNumPages: number | null = null;

  for (let page = 1; page <= pageLimit; page += 1) {
    const remainingMs = remainingLookupBudgetMs(started, budgetMs, now);
    if (remainingMs <= 0) {
      return { status: "unknown", reason: "timeout" };
    }
    const timeoutMs = lookupRequestTimeoutMs(remainingMs, perRequestCapMs);
    const signal = createTimeoutSignal(timeoutMs);
    let fetched: EsignListPageFetch;
    try {
      fetched = await input.fetchPage(page, { remainingMs, timeoutMs, signal });
    } catch (error) {
      if (signal.aborted || isLookupAbortError(error)) {
        return { status: "unknown", reason: "timeout" };
      }
      return { status: "unknown", reason: "error" };
    }
    if (!fetched.ok) {
      return { status: "unknown", reason: fetched.reason };
    }
    if (!Array.isArray(fetched.signatureRequests)) {
      return { status: "unknown", reason: "malformed" };
    }
    if (!Number.isInteger(fetched.numPages) || fetched.numPages < 1) {
      return { status: "unknown", reason: "unknown_total" };
    }
    lastNumPages = fetched.numPages;
    for (const row of fetched.signatureRequests) {
      const lookedUp = readEsignLookupRow(row);
      if (lookedUp && esignLookupRowMatches(lookedUp, input.query)) {
        matches.push(lookedUp);
      }
    }
    if (matches.length > 1) {
      return { status: "unknown", reason: "ambiguous" };
    }
    if (matches.length === 1) {
      // Stop on the first matching page. A later-page duplicate is not fetched.
      return {
        status: "found",
        requestId: matches[0].requestId,
        metadata: matches[0].metadata,
      };
    }
    if (page >= fetched.numPages) {
      return { status: "not_found_complete" };
    }
  }

  return decideListScanAfterPageLimit({ lastNumPages, pageLimit });
}
