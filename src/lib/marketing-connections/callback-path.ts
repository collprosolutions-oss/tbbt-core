/**
 * Meta and Google redirect the browser here without relying on the
 * session cookie. The auth proxy must not send these callbacks to sign-in.
 * The route rejects anything that is not a hashed single-use OWNER state.
 */
export const META_MARKETING_CONNECTION_CALLBACK_PATH = "/api/marketing/connections/meta/callback";
export const GOOGLE_MARKETING_CONNECTION_CALLBACK_PATH = "/api/marketing/connections/google/callback";

export function isMarketingConnectionCallbackPath(pathname: string) {
  return (
    pathname === META_MARKETING_CONNECTION_CALLBACK_PATH ||
    pathname === GOOGLE_MARKETING_CONNECTION_CALLBACK_PATH
  );
}
