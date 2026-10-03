/**
 * Gusto redirects the owner back here with a code and state. The auth
 * proxy must not send that browser navigation to sign-in before the
 * route can require the owner session itself.
 */
export const GUSTO_PAYROLL_CALLBACK_PATH = "/api/payroll/gusto/callback";

export function isGustoPayrollCallbackPath(pathname: string) {
  return pathname === GUSTO_PAYROLL_CALLBACK_PATH;
}
