/**
 * OWNER/ADMIN report of recorded request sources and the actual
 * request → estimate → job links in the same workspace.
 *
 * Starts from ServiceRequest rows. An estimate counts only when
 * Estimate.serviceRequestId points at that request. A job counts only
 * when Job.estimateId points at one of those estimates. Standalone
 * estimates, unlinked jobs, and a later working leadSource do not
 * invent a source or a conversion.
 *
 * Unknown / blank / unrecognized sources stay "unknown". This module
 * does not invent attribution, ad spend, conversion credit, tracking
 * cookies, ROI, or rankings.
 *
 * No next/headers dependency — authorization/isolation check scripts
 * import these helpers directly.
 */

import {
  isLeadSource,
  LEAD_SOURCE_LABELS,
  parseLeadSource,
  type LeadSource,
} from "@/lib/lead-attribution";

export const UNKNOWN_REQUEST_SOURCE = "unknown";

export const REQUEST_SOURCE_REPORT_REQUEST_TAKE = 200;
export const REQUEST_SOURCE_REPORT_CHILD_TAKE = 400;

export const REQUEST_SOURCE_REPORT_MESSAGE =
  "This report counts recorded request sources and the actual request → estimate → job links in this workspace. Unknown sources stay unknown. TBBT does not invent attribution, ad spend, conversion credit, or tracking cookies.";

export const REQUEST_SOURCE_REPORT_TRUNCATED_MESSAGE = `Showing the newest ${REQUEST_SOURCE_REPORT_REQUEST_TAKE} requests in this workspace. Older requests are outside this bounded sample.`;

export const REQUEST_SOURCE_REPORT_CHILD_TRUNCATED_MESSAGE =
  "Some linked estimates or jobs sit outside this bounded sample and were not counted.";

export type RequestSourceReportRequest = {
  id: string;
  leadSource: string | null;
  originalLeadSource: string | null;
};

export type RequestSourceReportEstimate = {
  id: string;
  serviceRequestId: string | null;
};

export type RequestSourceReportJob = {
  id: string;
  estimateId: string | null;
};

export type RequestSourceProgressionRow = {
  source: LeadSource | typeof UNKNOWN_REQUEST_SOURCE;
  label: string;
  requests: number;
  estimates: number;
  jobs: number;
};

export type RequestSourceProgression = {
  rows: RequestSourceProgressionRow[];
  sampledRequestCount: number;
  truncated: boolean;
  childTruncated: boolean;
  requestLimit: number;
  estimateLimit: number;
  jobLimit: number;
  message: string;
};

/**
 * First-touch recorded source on the request. originalLeadSource wins
 * when present so an owner correction of the working source cannot
 * invent a different first-touch bucket. Unrecognized values stay unknown.
 */
export function recordedRequestSource(
  request: Pick<RequestSourceReportRequest, "leadSource" | "originalLeadSource">,
): LeadSource | typeof UNKNOWN_REQUEST_SOURCE {
  return parseLeadSource(request.originalLeadSource) ?? parseLeadSource(request.leadSource) ?? UNKNOWN_REQUEST_SOURCE;
}

export function requestSourceReportLabel(
  source: string | null | undefined,
): string {
  if (isLeadSource(source)) return LEAD_SOURCE_LABELS[source];
  return UNKNOWN_REQUEST_SOURCE;
}

export function buildRequestSourceProgression(input: {
  requests: readonly RequestSourceReportRequest[];
  estimates: readonly RequestSourceReportEstimate[];
  jobs: readonly RequestSourceReportJob[];
  truncated?: boolean;
  childTruncated?: boolean;
}): RequestSourceProgression {
  const requestIds = new Set(input.requests.map((request) => request.id));
  const estimatesByRequest = new Map<string, string[]>();

  for (const estimate of input.estimates) {
    if (!estimate.serviceRequestId || !requestIds.has(estimate.serviceRequestId)) continue;
    const existing = estimatesByRequest.get(estimate.serviceRequestId);
    if (existing) existing.push(estimate.id);
    else estimatesByRequest.set(estimate.serviceRequestId, [estimate.id]);
  }

  const jobsByEstimate = new Set(
    input.jobs
      .map((job) => job.estimateId)
      .filter((estimateId): estimateId is string => Boolean(estimateId)),
  );

  const buckets = new Map<string, RequestSourceProgressionRow>();

  function bucket(source: LeadSource | typeof UNKNOWN_REQUEST_SOURCE) {
    const existing = buckets.get(source);
    if (existing) return existing;
    const created: RequestSourceProgressionRow = {
      source,
      label: requestSourceReportLabel(source),
      requests: 0,
      estimates: 0,
      jobs: 0,
    };
    buckets.set(source, created);
    return created;
  }

  for (const request of input.requests) {
    const row = bucket(recordedRequestSource(request));
    row.requests += 1;
    const estimateIds = estimatesByRequest.get(request.id) ?? [];
    if (estimateIds.length > 0) row.estimates += 1;
    if (estimateIds.some((estimateId) => jobsByEstimate.has(estimateId))) {
      row.jobs += 1;
    }
  }

  const rows = [...buckets.values()].sort((a, b) => {
    if (a.source === UNKNOWN_REQUEST_SOURCE && b.source !== UNKNOWN_REQUEST_SOURCE) return 1;
    if (b.source === UNKNOWN_REQUEST_SOURCE && a.source !== UNKNOWN_REQUEST_SOURCE) return -1;
    return b.requests - a.requests || a.label.localeCompare(b.label);
  });

  return {
    rows,
    sampledRequestCount: input.requests.length,
    truncated: Boolean(input.truncated),
    childTruncated: Boolean(input.childTruncated),
    requestLimit: REQUEST_SOURCE_REPORT_REQUEST_TAKE,
    estimateLimit: REQUEST_SOURCE_REPORT_CHILD_TAKE,
    jobLimit: REQUEST_SOURCE_REPORT_CHILD_TAKE,
    message: REQUEST_SOURCE_REPORT_MESSAGE,
  };
}

export function requestSourceReportCsvRows(report: RequestSourceProgression): {
  headers: string[];
  rows: string[][];
} {
  return {
    headers: ["Source", "Requests", "With estimate", "With job"],
    rows: report.rows.map((row) => [
      row.label,
      String(row.requests),
      String(row.estimates),
      String(row.jobs),
    ]),
  };
}
