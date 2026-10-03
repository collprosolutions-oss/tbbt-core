import {
  gustoApiHost,
  gustoEnvName,
  isFakeGustoAdapterEnabled,
  gustoFakeAdapterRefusedInProduction,
} from "@/lib/payroll-connect/config";
import { PayrollConnectError } from "@/lib/payroll-connect/errors";
import { createFakePayrollProvider } from "@/lib/payroll-connect/fake";
import { createGustoHttpPayrollProvider } from "@/lib/payroll-connect/gusto-http";
import type { PayrollProvider } from "@/lib/payroll-connect/types";

let cached: PayrollProvider | null = null;

export function getPayrollProvider(): PayrollProvider {
  if (!cached) {
    if (gustoFakeAdapterRefusedInProduction()) {
      throw new PayrollConnectError("NOT_AVAILABLE");
    }
    if (isFakeGustoAdapterEnabled()) {
      cached = createFakePayrollProvider();
    } else {
      const env = gustoEnvName() ?? "demo";
      cached = createGustoHttpPayrollProvider({ host: gustoApiHost(env) });
    }
  }
  return cached;
}

export function resetPayrollProvider() {
  cached = null;
}

export function setPayrollProvider(provider: PayrollProvider | null) {
  cached = provider;
}
