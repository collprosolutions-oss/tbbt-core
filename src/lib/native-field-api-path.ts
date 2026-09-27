/**
 * Native field API paths. These authenticate with a Bearer session
 * token, not the web `tbbt_session` cookie. The edge proxy must not
 * redirect them to /sign-in — the route itself proves the session.
 *
 * This is not a public website path. Missing/invalid Bearer tokens
 * still receive 401 from the route handlers.
 */
export const NATIVE_FIELD_API_PREFIX = "/api/native/v1";

export function isNativeFieldApiPath(pathname: string) {
  return (
    pathname === NATIVE_FIELD_API_PREFIX ||
    pathname.startsWith(`${NATIVE_FIELD_API_PREFIX}/`)
  );
}
