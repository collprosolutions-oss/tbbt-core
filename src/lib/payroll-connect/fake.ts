import { randomUUID } from "node:crypto";
import { FAKE_PAYROLL_PROVIDER } from "@/lib/payroll-connect/config";
import { GUSTO_HTTP_TIMEOUT_MS } from "@/lib/payroll-connect/copy";
import { PayrollConnectError } from "@/lib/payroll-connect/errors";
import { hashRawPayload } from "@/lib/payroll-connect/parse";
import type {
  GustoPayrollFactDraft,
  GustoTokenPair,
  PayrollProvider,
} from "@/lib/payroll-connect/types";

export type FakePayrollProvider = PayrollProvider & {
  companyId: string;
  refreshCount: number;
  exchangeCount: number;
  listCount: number;
  delayMs: number;
  invalidGrantNext: boolean;
  networkErrorNext: boolean;
  tokenInfoError: boolean;
  listInvalidGrant: boolean;
  beforeList: (() => Promise<void>) | null;
  payrolls: GustoPayrollFactDraft[];
  setCompanyId(value: string): void;
  setDelayMs(value: number): void;
  setInvalidGrantNext(value: boolean): void;
  setNetworkErrorNext(value: boolean): void;
  setTokenInfoError(value: boolean): void;
  setListInvalidGrant(value: boolean): void;
  setBeforeList(value: (() => Promise<void>) | null): void;
  setPayrolls(value: GustoPayrollFactDraft[]): void;
};

const DEMO_COMPANY_ID = "9aa93530-43d5-484e-b608-33214109420d";

export function createFakePayrollProvider(): FakePayrollProvider {
  const refreshTokens = new Map<string, true>();

  const provider: FakePayrollProvider = {
    id: FAKE_PAYROLL_PROVIDER,
    companyId: DEMO_COMPANY_ID,
    refreshCount: 0,
    exchangeCount: 0,
    listCount: 0,
    delayMs: 0,
    invalidGrantNext: false,
    networkErrorNext: false,
    tokenInfoError: false,
    listInvalidGrant: false,
    beforeList: null,
    payrolls: [],
    setCompanyId(value) {
      provider.companyId = value;
    },
    setDelayMs(value) {
      provider.delayMs = value;
    },
    setInvalidGrantNext(value) {
      provider.invalidGrantNext = value;
    },
    setNetworkErrorNext(value) {
      provider.networkErrorNext = value;
    },
    setTokenInfoError(value) {
      provider.tokenInfoError = value;
    },
    setListInvalidGrant(value) {
      provider.listInvalidGrant = value;
    },
    setBeforeList(value) {
      provider.beforeList = value;
    },
    setPayrolls(value) {
      provider.payrolls = value;
    },
    async exchangeAuthorizationCode() {
      provider.exchangeCount += 1;
      return issuePair();
    },
    async refreshAccessToken(input) {
      provider.refreshCount += 1;
      if (provider.networkErrorNext) {
        provider.networkErrorNext = false;
        throw new Error("network unreachable");
      }
      if (provider.delayMs > GUSTO_HTTP_TIMEOUT_MS) {
        await new Promise((resolve) => setTimeout(resolve, GUSTO_HTTP_TIMEOUT_MS));
        throw new PayrollConnectError("PROVIDER");
      }
      if (provider.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, provider.delayMs));
      }
      if (provider.invalidGrantNext || !refreshTokens.delete(input.refreshToken)) {
        provider.invalidGrantNext = false;
        throw new PayrollConnectError("INVALID_GRANT");
      }
      return issuePair();
    },
    async tokenInfo({ accessToken }) {
      if (provider.tokenInfoError) {
        provider.tokenInfoError = false;
        throw new PayrollConnectError("PROVIDER");
      }
      if (!accessToken.startsWith("fake_gusto_access_")) {
        throw new PayrollConnectError("INVALID_GRANT");
      }
      return {
        scope: "payrolls:read employees:read",
        companyId: provider.companyId,
        resourceType: "Company",
        resourceOwnerType: "CompanyAdmin",
      };
    },
    async listProcessedPayrolls() {
      provider.listCount += 1;
      if (provider.beforeList) {
        const hook = provider.beforeList;
        provider.beforeList = null;
        await hook();
      }
      if (provider.listInvalidGrant) {
        provider.listInvalidGrant = false;
        throw new PayrollConnectError("INVALID_GRANT");
      }
      return provider.payrolls.filter((row) => row.processed);
    },
  };

  function issuePair(): GustoTokenPair {
    const accessToken = `fake_gusto_access_${randomUUID()}`;
    const refreshToken = `fake_gusto_refresh_${randomUUID()}`;
    refreshTokens.set(refreshToken, true);
    return {
      accessToken,
      refreshToken,
      expiresIn: 7200,
      scope: "payrolls:read employees:read",
    };
  }

  return provider;
}

export function fakePayrollDraft(input: Partial<GustoPayrollFactDraft> & { providerPayrollId: string }): GustoPayrollFactDraft {
  return {
    providerPayrollId: input.providerPayrollId,
    payPeriodStart: input.payPeriodStart ?? null,
    payPeriodEnd: input.payPeriodEnd ?? null,
    checkDate: input.checkDate ?? null,
    processed: input.processed ?? true,
    grossTotalCents: input.grossTotalCents ?? null,
    employerTaxesCents: input.employerTaxesCents ?? null,
    employerBenefitsCents: input.employerBenefitsCents ?? null,
    rawPayloadHash: input.rawPayloadHash ?? hashRawPayload(input.providerPayrollId),
    lines: input.lines ?? [],
  };
}
