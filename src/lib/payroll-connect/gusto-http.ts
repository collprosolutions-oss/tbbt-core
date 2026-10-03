/**
 * Gusto App Integrations HTTP client.
 *
 * Authorize: GET {host}/oauth/authorize
 * Token:     POST {host}/oauth/token
 * Info:      GET  {host}/v1/token_info
 * Payrolls:  GET  {host}/v1/companies/{company_id}/payrolls
 *            processing_statuses=processed&include=totals
 * Detail:    GET  {host}/v1/companies/{company_id}/payrolls/{payroll_id}
 *
 * Demo host is https://api.gusto-demo.com. Production host is
 * https://api.gusto.com and is used only when GUSTO_ENV=production.
 * Docs: https://docs.gusto.com/app-integrations/docs/oauth2
 *       https://docs.gusto.com/app-integrations/docs/authentication
 */
import { GUSTO_API_VERSION, GUSTO_SCOPES } from "@/lib/payroll-connect/copy";
import { GUSTO_HTTP_PROVIDER } from "@/lib/payroll-connect/config";
import { PayrollConnectError } from "@/lib/payroll-connect/errors";
import { parseGustoPayrollPayload } from "@/lib/payroll-connect/parse";
import type {
  GustoPayrollFactDraft,
  GustoTokenInfo,
  GustoTokenPair,
  PayrollProvider,
} from "@/lib/payroll-connect/types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type GustoFetch = (url: string, init?: RequestInit) => Promise<Response>;

function assertUuid(value: string) {
  if (!UUID.test(value)) throw new PayrollConnectError("PROVIDER");
  return value;
}

async function readBody(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isInvalidGrantPayload(status: number, payload: unknown) {
  if (status === 401) return true;
  if (!payload || typeof payload !== "object") return false;
  const error = (payload as { error?: unknown }).error;
  return error === "invalid_grant" || error === "invalid_token";
}

function tokenPair(payload: unknown): GustoTokenPair {
  const row = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const accessToken = typeof row.access_token === "string" ? row.access_token : "";
  const refreshToken = typeof row.refresh_token === "string" ? row.refresh_token : "";
  const expiresIn = typeof row.expires_in === "number" ? row.expires_in : Number(row.expires_in);
  const scope = typeof row.scope === "string" ? row.scope : null;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new PayrollConnectError("PROVIDER");
  }
  return { accessToken, refreshToken, expiresIn, scope };
}

export function gustoAuthorizeUrl(input: {
  host: string;
  clientId: string;
  redirectUri: string;
  state: string;
}) {
  const url = new URL("/oauth/authorize", input.host);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", GUSTO_SCOPES);
  return url.toString();
}

export function gustoImportDateWindow(now = new Date()) {
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, now.getUTCDate()));
  return { startDate: startDate.toISOString().slice(0, 10), endDate: end };
}

export function createGustoHttpPayrollProvider(input: {
  host: string;
  fetchImpl?: GustoFetch;
}): PayrollProvider {
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const host = input.host;

  async function request(url: string, init: RequestInit, invalidGrantAsError: boolean) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new PayrollConnectError("PROVIDER");
    }
    const text = await readBody(response);
    const payload = parseJson(text);
    if (!response.ok) {
      if (invalidGrantAsError && isInvalidGrantPayload(response.status, payload)) {
        throw new PayrollConnectError("INVALID_GRANT");
      }
      throw new PayrollConnectError("PROVIDER");
    }
    return { text, payload };
  }

  async function postToken(body: Record<string, string>) {
    const { payload } = await request(
      new URL("/oauth/token", host).toString(),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      true,
    );
    return tokenPair(payload);
  }

  async function getJson(url: string, accessToken: string) {
    return request(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "X-Gusto-API-Version": GUSTO_API_VERSION,
        },
      },
      true,
    );
  }

  return {
    id: GUSTO_HTTP_PROVIDER,
    exchangeAuthorizationCode(tokenInput) {
      return postToken({
        client_id: tokenInput.clientId,
        client_secret: tokenInput.clientSecret,
        redirect_uri: tokenInput.redirectUri,
        code: tokenInput.code,
        grant_type: "authorization_code",
      });
    },
    refreshAccessToken(tokenInput) {
      return postToken({
        client_id: tokenInput.clientId,
        client_secret: tokenInput.clientSecret,
        redirect_uri: tokenInput.redirectUri,
        refresh_token: tokenInput.refreshToken,
        grant_type: "refresh_token",
      });
    },
    async tokenInfo({ accessToken }) {
      const { payload } = await getJson(new URL("/v1/token_info", host).toString(), accessToken);
      const row = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const resource =
        row.resource && typeof row.resource === "object" ? (row.resource as Record<string, unknown>) : {};
      const owner =
        row.resource_owner && typeof row.resource_owner === "object"
          ? (row.resource_owner as Record<string, unknown>)
          : null;
      const companyId = typeof resource.uuid === "string" ? resource.uuid : "";
      const resourceType = typeof resource.type === "string" ? resource.type : "";
      if (!companyId || resourceType !== "Company") throw new PayrollConnectError("PROVIDER");
      assertUuid(companyId);
      return {
        scope: typeof row.scope === "string" ? row.scope : "",
        companyId,
        resourceType,
        resourceOwnerType: owner && typeof owner.type === "string" ? owner.type : null,
      } satisfies GustoTokenInfo;
    },
    async listProcessedPayrolls({ accessToken, companyId, startDate, endDate }) {
      assertUuid(companyId);
      const drafts: GustoPayrollFactDraft[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const listUrl = new URL(`/v1/companies/${companyId}/payrolls`, host);
        listUrl.searchParams.set("processing_statuses", "processed");
        listUrl.searchParams.set("include", "totals");
        listUrl.searchParams.set("start_date", startDate);
        listUrl.searchParams.set("end_date", endDate);
        listUrl.searchParams.set("page", String(page));
        listUrl.searchParams.set("per", String(PAGE_SIZE));
        const listed = await getJson(listUrl.toString(), accessToken);
        const items = Array.isArray(listed.payload) ? listed.payload : [];
        for (const item of items) {
          const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          if (row.processed !== true) continue;
          const payrollId =
            (typeof row.payroll_uuid === "string" && row.payroll_uuid) ||
            (typeof row.uuid === "string" && row.uuid) ||
            "";
          if (!UUID.test(payrollId)) continue;
          const detailUrl = new URL(`/v1/companies/${companyId}/payrolls/${payrollId}`, host);
          detailUrl.searchParams.set("include", "totals");
          detailUrl.searchParams.set("per", String(PAGE_SIZE));
          const detail = await getJson(detailUrl.toString(), accessToken);
          const draft = parseGustoPayrollPayload(detail.payload, detail.text);
          if (draft?.processed) drafts.push(draft);
        }
        if (items.length < PAGE_SIZE) break;
      }
      return drafts;
    },
  };
}
