import type { ReportSource } from "@/lib/reports";
import type { FinanceConnectionStatus } from "@/lib/finance-connections";
import type { LaborBurdenConfig } from "@/lib/financial-intelligence/labor-burden";

export type FinancialPayment = {
  id: string;
  businessId: string;
  customerId: string | null;
  jobId: string | null;
  invoiceId: string | null;
  purpose: string;
  amount: number;
  method: string;
  receivedAt: Date;
};

export type FinancialChangeOrder = {
  id: string;
  jobId: string;
  status: string;
  total: number;
  approvedAt: Date | null;
};

export type FinancialEstimateLine = {
  estimateId: string;
  type: string;
  quantity: number;
  total: number;
  description?: string | null;
  fromApprovedVersion: boolean;
};

export type RecurringPatternRecord = {
  id: string;
  patternKey: string;
  description: string;
  vendor: string | null;
  category: string;
  suggestedAmount: number;
  occurrenceCount: number;
  firstOccurredOn: Date;
  lastOccurredOn: Date;
  ownerStatus: string;
};

export type FinancialJob = ReportSource["jobs"][number] & {
  scheduledDurationMinutes?: number | null;
};

export type FinancialSource = Omit<ReportSource, "jobs"> & {
  jobs: FinancialJob[];
  payments: FinancialPayment[];
  changeOrders: FinancialChangeOrder[];
  estimateLines: FinancialEstimateLine[];
  laborBurden: LaborBurdenConfig;
  financeConnections: FinanceConnectionStatus;
  recurringPatterns: RecurringPatternRecord[];
};
