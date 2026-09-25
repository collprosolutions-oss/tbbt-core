/**
 * Provider-neutral accounting and banking connection boundary.
 *
 * Financial intelligence reads recorded TBBT facts. External ledgers and
 * bank balances are never invented. A later PR may add a live adapter;
 * this release only exposes a disconnected provider.
 */

export const FINANCE_CONNECTION_KINDS = ["ACCOUNTING", "BANKING"] as const;
export type FinanceConnectionKind = (typeof FINANCE_CONNECTION_KINDS)[number];

export const FINANCE_CONNECTION_STATUSES = ["DISCONNECTED", "CONNECTED"] as const;
export type FinanceConnectionStatusCode = (typeof FINANCE_CONNECTION_STATUSES)[number];

export const ACCOUNTING_NOT_CONNECTED_MESSAGE =
  "Accounting is Not Connected. These figures are TBBT-recorded only.";

export const BANKING_NOT_CONNECTED_MESSAGE =
  "Banking is Not Connected. TBBT will not invent a cash balance.";

export type FinanceConnectionSnapshot = {
  kind: FinanceConnectionKind;
  providerKey: string;
  status: FinanceConnectionStatusCode;
  connected: boolean;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  message: string;
};

export type FinanceConnectionStatus = {
  accounting: FinanceConnectionSnapshot;
  banking: FinanceConnectionSnapshot;
};

export type ExternalBalanceResult = {
  ok: false;
  connected: false;
  balance: null;
  asOf: null;
  error: string;
};

export interface FinanceConnectionProvider {
  readonly id: string;
  readonly connected: boolean;
  snapshot(kind: FinanceConnectionKind): FinanceConnectionSnapshot;
  status(): FinanceConnectionStatus;
  fetchExternalBalance(): Promise<ExternalBalanceResult>;
}

export function isFinanceConnectionKind(value: string): value is FinanceConnectionKind {
  return (FINANCE_CONNECTION_KINDS as readonly string[]).includes(value);
}
