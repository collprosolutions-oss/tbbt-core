import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/cookies";

const AUTH_PATHS = ["/sign-in", "/sign-up"];

function isAuthPath(pathname: string) {
  return AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function isPublicIntake(pathname: string) {
  return pathname.startsWith("/r/");
}

function isPublicEstimate(pathname: string) {
  return pathname.startsWith("/e/");
}

function isPublicHire(pathname: string) {
  return pathname.startsWith("/hire/");
}

function isPublicHome(pathname: string) {
  return pathname === "/";
}

/** Existing secure public-asset route. The handler still checks PUBLIC + READY. */
function isPublicStoredAsset(pathname: string) {
  return pathname.startsWith("/api/storage/public/");
}

/** Customer Project Portal -- see src/app/p/[token]/page.tsx. */
function isPublicProject(pathname: string) {
  return pathname.startsWith("/p/");
}

/**
 * One-time team-member password-setup link -- see addTeamMember() in
 * src/app/actions/team.ts and src/app/set-password/[token]/page.tsx. Must
 * stay reachable without a session: the person opening this link has no
 * account credentials yet.
 */
function isPublicSetPassword(pathname: string) {
  return pathname.startsWith("/set-password/");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // `/` is always the public website. A signed-in owner still reaches
  // /dashboard by going there directly; the session must not hijack Home.
  if (
    isPublicHome(pathname) ||
    isPublicIntake(pathname) ||
    isPublicEstimate(pathname) ||
    isPublicHire(pathname) ||
    isPublicProject(pathname) ||
    isPublicSetPassword(pathname) ||
    isPublicStoredAsset(pathname)
  ) {
    return NextResponse.next();
  }

  if (!hasSession && !isAuthPath(pathname)) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  if (hasSession && isAuthPath(pathname)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // "brand" is public/brand -- static TBBT/business logo assets (see
    // src/lib/business-branding.ts) that must load unauthenticated, same
    // as the other static files already excluded here.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|brand/).*)",
  ],
};
