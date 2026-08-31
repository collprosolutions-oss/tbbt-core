export type PayrollKpi = {
  label: string;
  value: string;
  sublabel: string;
  defaultIconId: "calendar-days" | "check-circle" | "alert-triangle" | "circle-dollar";
};

export type PayrollReviewItem = {
  id: string;
  membershipId: string;
  timesheetWeekId: string;
  workerName: string;
  workerRole: string;
  workerActive: boolean;
  weekStartedAt: string;
  weekLabel: string;
  approvedHours: number;
  approvedHoursLabel: string;
  regularHours: number;
  regularHoursLabel: string;
  overtimeHours: number;
  overtimeHoursLabel: string;
  wageSnapshot: number | null;
  wageSnapshotLabel: string;
  grossLaborAmount: number | null;
  grossLabel: string;
  timesheetStatus: string;
  timesheetStatusLabel: string;
  readiness: string;
  exceptions: string[];
  exceptionLabels: string[];
  canRemove: boolean;
  timesheetHref: string;
};

export type PayrollAttentionRow = {
  key: string;
  label: string;
  detail: string;
};

export type PayrollHistoryRow = {
  id: string;
  periodLabel: string;
  status: string;
  statusLabel: string;
  workerCount: number;
  approvedHoursLabel: string;
  grossLabel: string;
  authorizedAtLabel: string | null;
  processedAtLabel: string | null;
};

export type PayrollAvailableWeek = {
  timesheetWeekId: string;
  membershipId: string;
  workerName: string;
  weekLabel: string;
  hoursLabel: string;
};

export type PayrollWorkspaceData = {
  runId: string | null;
  status: string;
  statusLabel: string;
  periodStart: string;
  periodEndInclusive: string;
  periodLabel: string;
  editable: boolean;
  locked: boolean;
  canReview: boolean;
  canAuthorize: boolean;
  canReopen: boolean;
  canCancel: boolean;
  canMarkProcessed: boolean;
  isOwner: boolean;
  workersReady: number;
  needsAttentionCount: number;
  estimatedGrossLabel: string;
  approvedHoursTotal: number;
  itemCount: number;
  items: PayrollReviewItem[];
  attention: PayrollAttentionRow[];
  availableWeeks: PayrollAvailableWeek[];
  history: PayrollHistoryRow[];
  fundingLabel: string;
  providerLabel: string;
  processedSourceLabel: string | null;
  providerReference: string | null;
  authorizedAtLabel: string | null;
  processedAtLabel: string | null;
  notes: string | null;
};
