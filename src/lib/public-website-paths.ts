import { isTbbtMarketingPublicPath } from "@/lib/tbbt-marketing-host";

/** Local fake Stripe checkout. The page 404s when the fake adapter is off. */
export const FAKE_STRIPE_TEST_CHECKOUT_PUBLIC_PREFIX = "/payments/test-checkout";

export function isFakeStripeTestCheckoutPath(pathname: string) {
  return (
    pathname === FAKE_STRIPE_TEST_CHECKOUT_PUBLIC_PREFIX ||
    pathname.startsWith(`${FAKE_STRIPE_TEST_CHECKOUT_PUBLIC_PREFIX}/`)
  );
}

/**
 * Paths the edge proxy must not treat as the signed-in app.
 * `/` is the public website for every visitor, including owners.
 * TBBT corporate marketing routes are also public so www.tbbtool.com
 * (and Preview/local review of those pages) is not bounced to sign-in.
 * The local Stripe test checkout is public so Pay Invoice is not sent
 * to sign-in. `/payments` itself stays private.
 */
export function isPublicWebsitePath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml" ||
    isTbbtMarketingPublicPath(pathname) ||
    pathname.startsWith("/r/") ||
    pathname.startsWith("/e/") ||
    pathname.startsWith("/hire/") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/set-password/") ||
    pathname.startsWith("/reset-password/") ||
    pathname.startsWith("/api/storage/public/") ||
    isFakeStripeTestCheckoutPath(pathname)
  );
}
