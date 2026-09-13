import {
  firstHeaderHost,
  isTrustedVercelAppHost,
} from "@/lib/vercel-app-host";

export type NavigationOriginInput = {
  requestUrl: string;
  hostHeader?: string | null;
  forwardedHostHeader?: string | null;
  vercelDeploymentUrl?: string | null;
  vercelEnv?: string | null;
};

function originFromTrustedVercelHost(value: string | null | undefined): string | null {
  const host = firstHeaderHost(value);
  if (!host || !isTrustedVercelAppHost(host)) {
    return null;
  }
  return `https://${host}`;
}

/**
 * Origin for in-app auth redirects (src/proxy.ts).
 *
 * NextResponse.redirect() requires an absolute URL. Building that URL
 * from `request.url` follows x-forwarded-host. On Vercel Preview that
 * header (and VERCEL_PROJECT_PRODUCTION_URL) is the production domain,
 * so unauthenticated Preview visitors were 307'd to collproreno.com and
 * then authenticated against production.
 *
 * When VERCEL_ENV is preview/development, prefer the current *.vercel.app
 * Host / x-vercel-deployment-url. Production hosts are left on request.url
 * so collproreno.com behavior is unchanged. Does not hard-code a Preview URL.
 */
export function navigationOrigin(input: NavigationOriginInput): string {
  const fallback = new URL(input.requestUrl).origin;
  const env = (input.vercelEnv ?? "").trim();
  if (env !== "preview" && env !== "development") {
    return fallback;
  }

  return (
    originFromTrustedVercelHost(input.hostHeader) ||
    originFromTrustedVercelHost(input.vercelDeploymentUrl) ||
    originFromTrustedVercelHost(input.forwardedHostHeader) ||
    fallback
  );
}

export function navigationRedirectUrl(
  path: string,
  input: NavigationOriginInput,
): URL {
  return new URL(path, navigationOrigin(input));
}
