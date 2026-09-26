import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/cookies";
import { navigationRedirectUrl } from "@/lib/navigation-origin";
import { isCustomerMessagingWebhookPath } from "@/lib/customer-messaging/config";
import { collproRenoLegacyHireRedirectPath } from "@/lib/public-site";
import { isPublicWebsitePath } from "@/lib/public-website-paths";
import { isStripeWebhookPath } from "@/lib/stripe-webhook-path";
import { tbbtApexWwwRedirectLocation } from "@/lib/tbbt-marketing-host";
import {
  firstHeaderHost,
  firstHeaderHostWithPort,
} from "@/lib/vercel-app-host";

const AUTH_PATHS = ["/sign-in", "/sign-up", "/forgot-password"];

function isAuthPath(pathname: string) {
  return AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function redirectOnCurrentDeployment(path: string, request: NextRequest) {
  // Do not use `new URL(path, request.url)`: on Vercel Preview, request.url
  // can be the production origin (collproreno.com) via x-forwarded-host.
  return NextResponse.redirect(
    navigationRedirectUrl(path, {
      requestUrl: request.url,
      hostHeader: request.headers.get("host"),
      forwardedHostHeader: request.headers.get("x-forwarded-host"),
      vercelDeploymentUrl: request.headers.get("x-vercel-deployment-url"),
      vercelEnv: process.env.VERCEL_ENV,
    }),
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const apexLocation = tbbtApexWwwRedirectLocation(
    firstHeaderHost(request.headers.get("host")),
    pathname,
    request.nextUrl.search,
  );
  if (apexLocation) {
    return NextResponse.redirect(apexLocation, 308);
  }

  const legacyHirePath = collproRenoLegacyHireRedirectPath(pathname);
  if (legacyHirePath) {
    return NextResponse.redirect(
      navigationRedirectUrl(`${legacyHirePath}${request.nextUrl.search}`, {
        requestUrl: request.url,
        hostHeader: request.headers.get("host"),
        forwardedHostHeader: request.headers.get("x-forwarded-host"),
        vercelDeploymentUrl: request.headers.get("x-vercel-deployment-url"),
        vercelEnv: process.env.VERCEL_ENV,
      }),
      308,
    );
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // `/` is always the public website. A signed-in owner still reaches
  // /dashboard by going there directly; the session must not hijack Home.
  if (isPublicWebsitePath(pathname) || isStripeWebhookPath(pathname) || isCustomerMessagingWebhookPath(pathname)) {
    // Vercel may set x-forwarded-host to the primary production domain
    // (www.collproreno.com) while the browser Origin is the custom host
    // (www.tbbtool.com). Next.js Server Action CSRF then aborts with
    // "Invalid Server Actions request." (E80) before intake.ts runs, and
    // the client maps that throw to PUBLIC_INTAKE_SUBMIT_ERROR.
    const csrfHost = firstHeaderHostWithPort(request.headers.get("host"));
    if (!csrfHost) {
      return NextResponse.next();
    }
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-forwarded-host", csrfHost);
    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  }

  if (!hasSession && !isAuthPath(pathname)) {
    return redirectOnCurrentDeployment("/sign-in", request);
  }

  if (hasSession && isAuthPath(pathname)) {
    return redirectOnCurrentDeployment("/dashboard", request);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // "brand" is public/brand -- static TBBT/business logo assets (see
    // src/lib/business-branding.ts) that must load unauthenticated, same
    // as the other static files already excluded here.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|brand/|api/stripe/webhook|api/customer-messaging/webhook).*)",
  ],
};
