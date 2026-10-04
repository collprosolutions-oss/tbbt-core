/**
 * Per-destination OAuth adapters.
 *
 * Live clients speak to Meta Graph and Google only when this process
 * calls them. Tests inject the fake adapter or a fetch double and make
 * no network call. Connecting never publishes.
 *
 * Facebook Login (manual code flow):
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 * Page list: GET /me/accounts
 * https://developers.facebook.com/docs/graph-api/reference/user/accounts/
 * Instagram via the linked Page's instagram_business_account:
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram/
 * Google web server flow:
 * https://developers.google.com/identity/protocols/oauth2/web-server
 * Business Profile accounts:
 * https://developers.google.com/my-business/content/implement-oauth
 * Location list uses the Business Information API. Local posts are not called here.
 */
import { FACEBOOK_GRAPH_API_HOST, FACEBOOK_GRAPH_API_VERSION } from "@/lib/social-publishing/facebook";
import {
  FACEBOOK_REQUIRED_SCOPES,
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  INSTAGRAM_REQUIRED_SCOPES,
  googleOAuthEnv,
  isFakeSocialOAuthAdapterEnabled,
  metaOAuthEnv,
  marketingDestinationAvailability,
  type MarketingConnectionDestination,
} from "@/lib/marketing-connections/config";
import { MarketingConnectionError, sanitizeConnectionError } from "@/lib/marketing-connections/errors";

export type OAuthCandidate = {
  externalId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  accountId: string;
};

export type OAuthExchangeResult = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  grantedScopes: string[];
  candidates: OAuthCandidate[];
};

export type OAuthRefreshResult =
  | { ok: true; accessToken: string; refreshToken: string | null; expiresAt: Date | null; grantedScopes: string[] }
  | { ok: false; error: string };

export type OAuthRevokeResult = {
  revoked: boolean;
  note: string;
};

export type MarketingOAuthAdapter = {
  id: string;
  destination: MarketingConnectionDestination;
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthExchangeResult>;
  refreshAccessToken(input: {
    refreshToken: string;
    accessToken: string;
    externalId: string;
  }): Promise<OAuthRefreshResult>;
  inspectAccessToken(input: { accessToken: string }): Promise<{ ok: boolean; grantedScopes: string[]; error?: string }>;
  revoke(input: { accessToken: string; refreshToken: string | null }): Promise<OAuthRevokeResult>;
};

export type FakeMarketingOAuthScript = {
  grantedScopes?: string[];
  userAccessToken?: string;
  userRefreshToken?: string | null;
  userExpiresInSeconds?: number | null;
  candidates?: OAuthCandidate[];
  refresh?: OAuthRefreshResult;
  inspect?: { ok: boolean; grantedScopes?: string[]; error?: string };
  revoke?: OAuthRevokeResult;
  exchangeError?: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

let fakeScriptOverride: FakeMarketingOAuthScript | null = null;
const fakeExchangeRedirectUris: string[] = [];

/** Test-only script for the process-wide fake adapter. Ignored unless the fake adapter is enabled. */
export function setFakeMarketingOAuthScript(script: FakeMarketingOAuthScript | null) {
  fakeScriptOverride = script;
}

export function clearFakeMarketingOAuthExchangeRedirectUris() {
  fakeExchangeRedirectUris.length = 0;
}

export function resetFakeMarketingOAuthProbe() {
  fakeScriptOverride = null;
  fakeExchangeRedirectUris.length = 0;
}

export function fakeMarketingOAuthExchangeRedirectUris() {
  return [...fakeExchangeRedirectUris];
}

function expiresFromSeconds(seconds: number | null | undefined, now: Date) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now.getTime() + seconds * 1000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function createFakeMarketingOAuthAdapter(
  destination: MarketingConnectionDestination,
  script: FakeMarketingOAuthScript = {},
  now: () => Date = () => new Date(),
): MarketingOAuthAdapter {
  const granted = script.grantedScopes ?? (destination === "GOOGLE"
    ? [GOOGLE_BUSINESS_MANAGE_SCOPE]
    : destination === "INSTAGRAM"
      ? [...INSTAGRAM_REQUIRED_SCOPES]
      : [...FACEBOOK_REQUIRED_SCOPES]);
  return {
    id: "fake-marketing-oauth",
    destination,
    authorizeUrl({ state, redirectUri }) {
      const url = new URL(`https://oauth.fake.test/${destination.toLowerCase()}`);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      return url.toString();
    },
    async exchangeCode({ redirectUri }) {
      fakeExchangeRedirectUris.push(redirectUri);
      if (script.exchangeError) {
        throw new MarketingConnectionError(sanitizeConnectionError(script.exchangeError));
      }
      return {
        accessToken: script.userAccessToken ?? `fake-user-${destination.toLowerCase()}`,
        refreshToken: script.userRefreshToken ?? null,
        expiresAt: expiresFromSeconds(script.userExpiresInSeconds, now()),
        grantedScopes: granted,
        candidates: script.candidates ?? [],
      };
    },
    async refreshAccessToken() {
      if (script.refresh) return script.refresh;
      return { ok: false, error: "Fake provider has no refresh result." };
    },
    async inspectAccessToken() {
      if (script.inspect) {
        return {
          ok: script.inspect.ok,
          grantedScopes: script.inspect.grantedScopes ?? granted,
          error: script.inspect.error,
        };
      }
      return { ok: true, grantedScopes: granted };
    },
    async revoke() {
      return (
        script.revoke ?? {
          revoked: destination === "GOOGLE",
          note:
            destination === "GOOGLE"
              ? "Google token revoke endpoint accepted the request."
              : "Meta permission removal was requested. Remote revocation is best-effort and may not invalidate an already issued Page token.",
        }
      );
    },
  };
}

export function metaAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}) {
  const url = new URL(`${FACEBOOK_GRAPH_API_HOST.replace("graph.facebook.com", "www.facebook.com")}/${FACEBOOK_GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scopes.join(","));
  return url.toString();
}

export function googleAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_BUSINESS_MANAGE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function graphMessage(payload: unknown, fallback: string, secrets: string[]) {
  const error = asRecord(asRecord(payload)?.error);
  const message = typeof error?.message === "string" ? error.message : fallback;
  return sanitizeConnectionError(message, secrets);
}

export function createMetaMarketingOAuthAdapter(input: {
  destination: "FACEBOOK" | "INSTAGRAM";
  appId: string;
  appSecret: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}): MarketingOAuthAdapter {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const scopes = input.destination === "INSTAGRAM" ? INSTAGRAM_REQUIRED_SCOPES : FACEBOOK_REQUIRED_SCOPES;
  const host = `${FACEBOOK_GRAPH_API_HOST}/${FACEBOOK_GRAPH_API_VERSION}`;

  async function tokenRequest(params: URLSearchParams, secrets: string[]) {
    const response = await fetchImpl(`${host}/oauth/access_token?${params.toString()}`);
    const payload = await readJson(response);
    const record = asRecord(payload);
    const accessToken = typeof record?.access_token === "string" ? record.access_token : "";
    if (!response.ok || !accessToken) {
      throw new MarketingConnectionError(graphMessage(payload, "Meta token exchange failed.", secrets));
    }
    const expiresIn = typeof record?.expires_in === "number" ? record.expires_in : null;
    return { accessToken, expiresAt: expiresFromSeconds(expiresIn, now()) };
  }

  return {
    id: "meta-oauth",
    destination: input.destination,
    authorizeUrl({ state, redirectUri }) {
      return metaAuthorizeUrl({ appId: input.appId, redirectUri, state, scopes });
    },
    async exchangeCode({ code, redirectUri }) {
      const secrets = [input.appSecret, code];
      const shortLived = await tokenRequest(
        new URLSearchParams({
          client_id: input.appId,
          redirect_uri: redirectUri,
          client_secret: input.appSecret,
          code,
        }),
        secrets,
      );
      secrets.push(shortLived.accessToken);
      let userToken = shortLived.accessToken;
      let userExpires = shortLived.expiresAt;
      try {
        const longLived = await tokenRequest(
          new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: input.appId,
            client_secret: input.appSecret,
            fb_exchange_token: shortLived.accessToken,
          }),
          secrets,
        );
        userToken = longLived.accessToken;
        userExpires = longLived.expiresAt;
        secrets.push(userToken);
      } catch {
        userToken = shortLived.accessToken;
        userExpires = shortLived.expiresAt;
      }
      const granted = await readGrantedScopes(fetchImpl, host, input.appId, input.appSecret, userToken);
      const accountsUrl = new URL(`${host}/me/accounts`);
      accountsUrl.searchParams.set(
        "fields",
        "id,name,access_token,instagram_business_account{id,username}",
      );
      accountsUrl.searchParams.set("access_token", userToken);
      const accountsResponse = await fetchImpl(accountsUrl.toString());
      const accountsPayload = await readJson(accountsResponse);
      if (!accountsResponse.ok) {
        throw new MarketingConnectionError(graphMessage(accountsPayload, "Meta could not list Pages.", secrets));
      }
      const data = asRecord(accountsPayload)?.data;
      const pages = Array.isArray(data) ? data : [];
      const candidates: OAuthCandidate[] = [];
      for (const page of pages) {
        const record = asRecord(page);
        if (!record) continue;
        const pageId = typeof record.id === "string" ? record.id : "";
        const pageToken = typeof record.access_token === "string" ? record.access_token : "";
        const pageName = typeof record.name === "string" ? record.name : pageId;
        if (!pageId || !pageToken) continue;
        if (input.destination === "FACEBOOK") {
          candidates.push({
            externalId: pageId,
            displayName: pageName,
            accessToken: pageToken,
            refreshToken: userToken,
            expiresAt: userExpires,
            accountId: pageId,
          });
          continue;
        }
        const ig = asRecord(record.instagram_business_account);
        const igId = typeof ig?.id === "string" ? ig.id : "";
        const username = typeof ig?.username === "string" ? ig.username : "";
        if (!igId) continue;
        candidates.push({
          externalId: igId,
          displayName: username ? `@${username}` : pageName,
          accessToken: pageToken,
          refreshToken: userToken,
          expiresAt: userExpires,
          accountId: pageId,
        });
      }
      return {
        accessToken: userToken,
        refreshToken: null,
        expiresAt: userExpires,
        grantedScopes: granted,
        candidates,
      };
    },
    async refreshAccessToken({ refreshToken, externalId }) {
      try {
        const exchanged = await tokenRequest(
          new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: input.appId,
            client_secret: input.appSecret,
            fb_exchange_token: refreshToken,
          }),
          [input.appSecret, refreshToken],
        );
        const accountsUrl = new URL(`${host}/me/accounts`);
        accountsUrl.searchParams.set("fields", "id,access_token,instagram_business_account{id}");
        accountsUrl.searchParams.set("access_token", exchanged.accessToken);
        const response = await fetchImpl(accountsUrl.toString());
        const payload = await readJson(response);
        const data = Array.isArray(asRecord(payload)?.data) ? (asRecord(payload)?.data as unknown[]) : [];
        for (const page of data) {
          const record = asRecord(page);
          if (!record) continue;
          const pageToken = typeof record.access_token === "string" ? record.access_token : "";
          const pageId = typeof record.id === "string" ? record.id : "";
          const igId = typeof asRecord(record.instagram_business_account)?.id === "string"
            ? String(asRecord(record.instagram_business_account)?.id)
            : "";
          const matches = input.destination === "INSTAGRAM" ? igId === externalId : pageId === externalId;
          if (matches && pageToken) {
            const granted = await readGrantedScopes(fetchImpl, host, input.appId, input.appSecret, exchanged.accessToken);
            return {
              ok: true as const,
              accessToken: pageToken,
              refreshToken: exchanged.accessToken,
              expiresAt: exchanged.expiresAt,
              grantedScopes: granted,
            };
          }
        }
        return { ok: false as const, error: "Meta did not return a token for the selected destination." };
      } catch (error) {
        return {
          ok: false,
          error: sanitizeConnectionError(error instanceof Error ? error.message : "Meta refresh failed.", [refreshToken]),
        };
      }
    },
    async inspectAccessToken({ accessToken }) {
      try {
        const granted = await readGrantedScopes(fetchImpl, host, input.appId, input.appSecret, accessToken);
        return { ok: true, grantedScopes: granted };
      } catch (error) {
        return {
          ok: false,
          grantedScopes: [],
          error: sanitizeConnectionError(error instanceof Error ? error.message : "Meta token check failed.", [accessToken]),
        };
      }
    },
    async revoke({ refreshToken, accessToken }) {
      const token = refreshToken || accessToken;
      try {
        const url = new URL(`${host}/me/permissions`);
        url.searchParams.set("access_token", token);
        const response = await fetchImpl(url.toString(), { method: "DELETE" });
        if (!response.ok) {
          return {
            revoked: false,
            note: "Meta permission removal was requested and was not confirmed. Local tokens will still be wiped. Remote Page tokens may remain valid until Meta invalidates them.",
          };
        }
        return {
          revoked: true,
          note: "Meta permission removal was accepted for the user token. An already issued Page token may remain valid until Meta invalidates it. Local tokens were wiped.",
        };
      } catch {
        return {
          revoked: false,
          note: "Meta permission removal could not be completed. Local tokens were wiped. Remote revocation was not confirmed.",
        };
      }
    },
  };
}

async function readGrantedScopes(
  fetchImpl: FetchLike,
  host: string,
  appId: string,
  appSecret: string,
  accessToken: string,
) {
  const appToken = `${appId}|${appSecret}`;
  const debugUrl = new URL(`${host}/debug_token`);
  debugUrl.searchParams.set("input_token", accessToken);
  debugUrl.searchParams.set("access_token", appToken);
  const debugResponse = await fetchImpl(debugUrl.toString());
  const debugPayload = await readJson(debugResponse);
  const data = asRecord(asRecord(debugPayload)?.data);
  const scopes = Array.isArray(data?.scopes) ? data.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  if (debugResponse.ok && scopes.length > 0) return scopes;
  const permissionsUrl = new URL(`${host}/me/permissions`);
  permissionsUrl.searchParams.set("access_token", accessToken);
  const permissionsResponse = await fetchImpl(permissionsUrl.toString());
  const permissionsPayload = await readJson(permissionsResponse);
  const rows = Array.isArray(asRecord(permissionsPayload)?.data) ? (asRecord(permissionsPayload)?.data as unknown[]) : [];
  const granted = rows
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => Boolean(row && row.status === "granted" && typeof row.permission === "string"))
    .map((row) => String(row.permission));
  if (!permissionsResponse.ok && scopes.length === 0) {
    throw new MarketingConnectionError(
      graphMessage(debugPayload, "Meta could not read granted permissions.", [accessToken, appSecret]),
    );
  }
  return granted.length > 0 ? granted : scopes;
}

export function createGoogleMarketingOAuthAdapter(input: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
}): MarketingOAuthAdapter {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());

  async function tokenGrant(body: URLSearchParams, secrets: string[]) {
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = await readJson(response);
    const record = asRecord(payload);
    const accessToken = typeof record?.access_token === "string" ? record.access_token : "";
    if (!response.ok || !accessToken) {
      const message = typeof record?.error_description === "string"
        ? record.error_description
        : typeof record?.error === "string"
          ? record.error
          : "Google token exchange failed.";
      throw new MarketingConnectionError(sanitizeConnectionError(message, secrets));
    }
    const refreshToken = typeof record?.refresh_token === "string" ? record.refresh_token : null;
    const expiresIn = typeof record?.expires_in === "number" ? record.expires_in : null;
    const scope = typeof record?.scope === "string" ? record.scope.split(/\s+/).filter(Boolean) : [];
    return { accessToken, refreshToken, expiresAt: expiresFromSeconds(expiresIn, now()), grantedScopes: scope };
  }

  return {
    id: "google-oauth",
    destination: "GOOGLE",
    authorizeUrl({ state, redirectUri }) {
      return googleAuthorizeUrl({ clientId: input.clientId, redirectUri, state });
    },
    async exchangeCode({ code, redirectUri }) {
      const secrets = [input.clientSecret, code];
      const token = await tokenGrant(
        new URLSearchParams({
          code,
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        secrets,
      );
      secrets.push(token.accessToken);
      const accountsResponse = await fetchImpl("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
        headers: { Authorization: `Bearer ${token.accessToken}` },
      });
      const accountsPayload = await readJson(accountsResponse);
      if (!accountsResponse.ok) {
        throw new MarketingConnectionError(
          sanitizeConnectionError(
            googleApiMessage(accountsPayload, "Google could not list Business Profile accounts."),
            secrets,
          ),
        );
      }
      const accounts = Array.isArray(asRecord(accountsPayload)?.accounts)
        ? (asRecord(accountsPayload)?.accounts as unknown[])
        : [];
      const candidates: OAuthCandidate[] = [];
      for (const account of accounts) {
        const record = asRecord(account);
        const accountName = typeof record?.name === "string" ? record.name : "";
        if (!accountName) continue;
        const locationsUrl = new URL(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
        );
        locationsUrl.searchParams.set("readMask", "name,title");
        const locationsResponse = await fetchImpl(locationsUrl.toString(), {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        });
        const locationsPayload = await readJson(locationsResponse);
        if (!locationsResponse.ok) {
          throw new MarketingConnectionError(
            sanitizeConnectionError(
              googleApiMessage(locationsPayload, "Google could not list Business Profile locations."),
              secrets,
            ),
          );
        }
        const locations = Array.isArray(asRecord(locationsPayload)?.locations)
          ? (asRecord(locationsPayload)?.locations as unknown[])
          : [];
        for (const location of locations) {
          const locationRecord = asRecord(location);
          const locationName = typeof locationRecord?.name === "string" ? locationRecord.name : "";
          const title = typeof locationRecord?.title === "string" ? locationRecord.title : locationName;
          if (!locationName) continue;
          const externalId = locationName.startsWith("accounts/")
            ? locationName
            : `${accountName}/${locationName}`;
          candidates.push({
            externalId,
            displayName: title,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            expiresAt: token.expiresAt,
            accountId: accountName,
          });
        }
      }
      return {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        grantedScopes: token.grantedScopes.length > 0 ? token.grantedScopes : [GOOGLE_BUSINESS_MANAGE_SCOPE],
        candidates,
      };
    },
    async refreshAccessToken({ refreshToken }) {
      try {
        const token = await tokenGrant(
          new URLSearchParams({
            refresh_token: refreshToken,
            client_id: input.clientId,
            client_secret: input.clientSecret,
            grant_type: "refresh_token",
          }),
          [input.clientSecret, refreshToken],
        );
        return {
          ok: true,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken ?? refreshToken,
          expiresAt: token.expiresAt,
          grantedScopes: token.grantedScopes.length > 0 ? token.grantedScopes : [GOOGLE_BUSINESS_MANAGE_SCOPE],
        };
      } catch (error) {
        return {
          ok: false,
          error: sanitizeConnectionError(error instanceof Error ? error.message : "Google refresh failed.", [refreshToken]),
        };
      }
    },
    async inspectAccessToken({ accessToken }) {
      const response = await fetchImpl(
        `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
      );
      const payload = await readJson(response);
      const record = asRecord(payload);
      if (!response.ok) {
        return {
          ok: false,
          grantedScopes: [],
          error: sanitizeConnectionError(
            typeof record?.error_description === "string" ? record.error_description : "Google token check failed.",
            [accessToken],
          ),
        };
      }
      const scope = typeof record?.scope === "string" ? record.scope.split(/\s+/).filter(Boolean) : [];
      return { ok: true, grantedScopes: scope };
    },
    async revoke({ refreshToken, accessToken }) {
      const token = refreshToken || accessToken;
      try {
        const response = await fetchImpl("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }).toString(),
        });
        if (!response.ok) {
          return {
            revoked: false,
            note: "Google token revoke was not confirmed. Local tokens were wiped.",
          };
        }
        return {
          revoked: true,
          note: "Google token revoke endpoint accepted the request. Local tokens were wiped.",
        };
      } catch {
        return {
          revoked: false,
          note: "Google token revoke could not be completed. Local tokens were wiped.",
        };
      }
    },
  };
}

function googleApiMessage(payload: unknown, fallback: string) {
  const error = asRecord(asRecord(payload)?.error);
  if (typeof error?.message === "string" && error.message.trim()) return error.message;
  if (typeof error?.status === "string" && error.status === "PERMISSION_DENIED") {
    return "Google Business Profile API access is not approved for this app.";
  }
  return fallback;
}

export function resolveMarketingOAuthAdapter(
  destination: MarketingConnectionDestination,
): MarketingOAuthAdapter | null {
  const availability = marketingDestinationAvailability(destination);
  if (!availability.available) return null;
  if (isFakeSocialOAuthAdapterEnabled()) {
    return createFakeMarketingOAuthAdapter(destination, fakeScriptOverride ?? {});
  }
  if (destination === "GOOGLE") {
    const google = googleOAuthEnv();
    return createGoogleMarketingOAuthAdapter({
      clientId: google.clientId,
      clientSecret: google.clientSecret,
    });
  }
  const meta = metaOAuthEnv();
  return createMetaMarketingOAuthAdapter({
    destination,
    appId: meta.appId,
    appSecret: meta.appSecret,
  });
}
