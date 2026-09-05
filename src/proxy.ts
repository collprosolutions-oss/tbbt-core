import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/cookies";
import { isPublicWebsitePath } from "@/lib/public-website-paths";

const AUTH_PATHS = ["/sign-in", "/sign-up"];

function isAuthPath(pathname: string) {
  return AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // `/` is always the public website. A signed-in owner still reaches
  // /dashboard by going there directly; the session must not hijack Home.
  if (isPublicWebsitePath(pathname)) {
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
