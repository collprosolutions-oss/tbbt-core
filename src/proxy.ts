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

/** Customer Project Portal -- see src/app/p/[token]/page.tsx. */
function isPublicProject(pathname: string) {
  return pathname.startsWith("/p/");
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/") {
    return NextResponse.redirect(
      new URL(hasSession ? "/dashboard" : "/sign-in", request.url),
    );
  }

  if (
    isPublicIntake(pathname) ||
    isPublicEstimate(pathname) ||
    isPublicHire(pathname) ||
    isPublicProject(pathname)
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
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg).*)",
  ],
};
