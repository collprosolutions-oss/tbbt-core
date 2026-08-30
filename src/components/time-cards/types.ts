export const TIME_CARD_VIEWS = ["today", "timesheets", "approvals", "crew"] as const;
export type TimeCardView = (typeof TIME_CARD_VIEWS)[number];

export type TimeCardJobOption = {
  id: string;
  label: string;
  assignedMembershipId: string | null;
};

export type TimeCardWorker = {
  membershipId: string;
  name: string;
  role: string;
  active: boolean;
  hourlyWageLabel: string | null;
  hourlyWageInput: string;
  weekStatus: "OPEN" | "APPROVED";
  payrollReady: boolean;
  clockedIn: boolean;
  currentActivityLabel: string | null;
};

export type TimeCardEntry = {
  id: string;
  membershipId: string;
  workerName: string;
  workerRole: string;
  jobId: string | null;
  jobLabel: string | null;
  activityType: string;
  activityLabel: string;
  status: string;
  statusLabel: string;
  source: string;
  startedAt: string;
  endedAt: string | null;
  startedAtLabel: string;
  endedAtLabel: string | null;
  clockLabel: string;
  totalHours: number;
  totalLabel: string;
  note: string | null;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  canEdit: boolean;
};

export type TimeCardAdjustment = {
  id: string;
  timeEntryId: string;
  action: string;
  reason: string | null;
  createdAtLabel: string;
  actorName: string;
};

export type TimeCardKpi = {
  label: string;
  value: string;
  sublabel: string;
  defaultIconId: "clock" | "timer" | "alert-triangle" | "circle-dollar";
};
