/**
 * Paths the edge proxy must not treat as the signed-in app.
 * `/` is the public website for every visitor, including owners.
 */
export function isPublicWebsitePath(pathname: string) {
  return (
    pathname === "/" ||
    pathname.startsWith("/r/") ||
    pathname.startsWith("/e/") ||
    pathname.startsWith("/hire/") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/set-password/") ||
    pathname.startsWith("/api/storage/public/")
  );
}
