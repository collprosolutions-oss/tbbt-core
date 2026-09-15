import { isTbbtMarketingPublicPath } from "@/lib/tbbt-marketing-host";

/**
 * Paths the edge proxy must not treat as the signed-in app.
 * `/` is the public website for every visitor, including owners.
 * TBBT corporate marketing routes are also public so tbbtools.com
 * (and Preview/local review of those pages) is not bounced to sign-in.
 */
export function isPublicWebsitePath(pathname: string) {
  return (
    pathname === "/" ||
    isTbbtMarketingPublicPath(pathname) ||
    pathname.startsWith("/r/") ||
    pathname.startsWith("/e/") ||
    pathname.startsWith("/hire/") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/set-password/") ||
    pathname.startsWith("/api/storage/public/")
  );
}
