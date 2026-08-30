export type ServiceCatalogListItem = {
  id: string;
  name: string;
  description: string;
  pricingMode: string;
  price: string;
  displayPrice: string;
  category: string;
  active: boolean;
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
