import {
  ACCOUNTING_NOT_CONNECTED_MESSAGE,
  BANKING_NOT_CONNECTED_MESSAGE,
  type ExternalBalanceResult,
  type FinanceConnectionKind,
  type FinanceConnectionProvider,
  type FinanceConnectionSnapshot,
  type FinanceConnectionStatus,
} from "@/lib/finance-connections/types";

function disconnectedSnapshot(kind: FinanceConnectionKind): FinanceConnectionSnapshot {
  return {
    kind,
    providerKey: "none",
    status: "DISCONNECTED",
    connected: false,
    connectedAt: null,
    lastSyncedAt: null,
    message: kind === "ACCOUNTING" ? ACCOUNTING_NOT_CONNECTED_MESSAGE : BANKING_NOT_CONNECTED_MESSAGE,
  };
}

export class DisconnectedFinanceProvider implements FinanceConnectionProvider {
  readonly id = "none";
  readonly connected = false;

  snapshot(kind: FinanceConnectionKind): FinanceConnectionSnapshot {
    return disconnectedSnapshot(kind);
  }

  status(): FinanceConnectionStatus {
    return {
      accounting: disconnectedSnapshot("ACCOUNTING"),
      banking: disconnectedSnapshot("BANKING"),
    };
  }

  async fetchExternalBalance(): Promise<ExternalBalanceResult> {
    return {
      ok: false,
      connected: false,
      balance: null,
      asOf: null,
      error: BANKING_NOT_CONNECTED_MESSAGE,
    };
  }
}
