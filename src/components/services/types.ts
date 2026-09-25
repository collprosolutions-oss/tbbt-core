export type ServiceCatalogListItem = {
  id: string;
  name: string;
  description: string;
  pricingMode: string;
  price: string;
  displayPrice: string;
  category: string;
  active: boolean;
  tradeCode: string;
  recurrenceEligible: boolean;
  unitLabel: string;
};

export type LaborMinimumSummary = {
  enabled: boolean;
  amountLabel: string | null;
};

export type StarterCatalogSummary = {
  addCount: number;
  skipCount: number;
  pendingCount: number;
};

export type TradeStarterCatalogPlan = StarterCatalogSummary & {
  code: string;
  label: string;
};

export type ActiveCatalogTradeOption = {
  code: string;
  label: string;
  recurrenceSupport: boolean;
};
