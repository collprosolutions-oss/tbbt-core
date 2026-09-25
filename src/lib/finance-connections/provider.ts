import { DisconnectedFinanceProvider } from "@/lib/finance-connections/disconnected";
import type { FinanceConnectionProvider } from "@/lib/finance-connections/types";

let cached: FinanceConnectionProvider | null = null;

/**
 * Accounting and banking stay disconnected unless a later release
 * registers a real adapter. Env strings do not invent a connection.
 */
export function getFinanceConnectionProvider(): FinanceConnectionProvider {
  if (!cached) cached = new DisconnectedFinanceProvider();
  return cached;
}

export function resetFinanceConnectionProvider() {
  cached = null;
}

export function setFinanceConnectionProvider(provider: FinanceConnectionProvider | null) {
  cached = provider;
}
