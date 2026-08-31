import type { CuratedIconId } from "@/lib/founder-icons";
import type { ExpenseCategory } from "@/lib/expenses";

export type ExpenseKpi = {
  label: string;
  value: string;
  sublabel: string;
  defaultIconId: CuratedIconId;
  accentClassName?: string;
};

export type ExpenseCategoryCard = {
  category: ExpenseCategory;
  label: string;
  amountLabel: string;
  percent: number;
  count: number;
  href: string;
  active: boolean;
};

export type ExpenseListItem = {
  id: string;
  occurredOnLabel: string;
  description: string;
  vendor: string | null;
  category: string;
  categoryLabel: string;
  amountLabel: string;
  purchaserName: string | null;
  purchaserInitials: string | null;
  jobLabel: string | null;
  customerName: string | null;
  hasReceipt: boolean;
  receiptUrl: string | null;
  reimbursable: boolean;
  reimbursementStatus: string;
  reimbursementLabel: string;
  paymentMethodLabel: string | null;
  reviewStatus: string;
  reviewLabel: string;
  recurring: boolean;
  mileageMilesLabel: string | null;
  notes: string | null;
  taxCategoryLabel: string | null;
};

export type ExpenseWorkerOption = {
  membershipId: string;
  name: string;
};

export type ExpenseJobOption = {
  id: string;
  label: string;
  customerId: string | null;
};

export type ExpenseCustomerOption = {
  id: string;
  name: string;
};

export type ExpenseFinancialOverview = {
  bankConnected: false;
  verifiedBalanceLabel: "Not connected";
  knownInflowsLabel: string;
  knownInflowsDetail: string;
  knownOutflowsLabel: string;
  knownOutflowsDetail: string;
  projectedBalanceLabel: "Unavailable";
  projectedDetail: string;
};

export type ExpenseFilterChip = {
  key: string;
  label: string;
  clearHref: string;
};

export type ExpenseWorkspaceData = {
  items: ExpenseListItem[];
  workers: ExpenseWorkerOption[];
  jobs: ExpenseJobOption[];
  customers: ExpenseCustomerOption[];
  financial: ExpenseFinancialOverview;
  filters: ExpenseFilterChip[];
  storageConfigured: boolean;
  defaultDate: string;
  page: number;
  totalPages: number;
  pageSize: number;
  matchedCount: number;
  rangeStartRow: number;
  rangeEndRow: number;
  pageHrefs: { prev: string | null; next: string | null; pages: { n: number; href: string }[] };
};
