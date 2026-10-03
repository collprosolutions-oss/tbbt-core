export type GustoTokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string | null;
};

export type GustoTokenInfo = {
  scope: string;
  companyId: string;
  resourceType: string;
  resourceOwnerType: string | null;
};

export type GustoPayrollFactLineDraft = {
  providerEmployeeId: string | null;
  employeeName: string | null;
  grossCents: number | null;
};

export type GustoPayrollFactDraft = {
  providerPayrollId: string;
  payPeriodStart: string | null;
  payPeriodEnd: string | null;
  checkDate: string | null;
  processed: boolean;
  grossTotalCents: number | null;
  employerTaxesCents: number | null;
  employerBenefitsCents: number | null;
  rawPayloadHash: string;
  lines: GustoPayrollFactLineDraft[];
};

export type PayrollProvider = {
  id: string;
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GustoTokenPair>;
  refreshAccessToken(input: {
    refreshToken: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GustoTokenPair>;
  tokenInfo(input: { accessToken: string }): Promise<GustoTokenInfo>;
  listProcessedPayrolls(input: {
    accessToken: string;
    companyId: string;
    startDate: string;
    endDate: string;
  }): Promise<GustoPayrollFactDraft[]>;
};
