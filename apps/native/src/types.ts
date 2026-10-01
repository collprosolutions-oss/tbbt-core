export type NativeViewer = {
  id: string;
  name: string;
  email: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
};

export type NativeWorkspace = {
  businessId: string;
  businessName: string;
  membershipId: string;
  role: "OWNER" | "ADMIN" | "MEMBER";
};

export type NativeJobSummary = {
  id: string;
  status: string;
  scheduledAt: string | null;
  scheduledDurationMinutes: number | null;
  whenLabel: string | null;
  customerName: string | null;
  address: string | null;
};

export type NativeJobCompleteAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobStartAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobStopTimeAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobActivityAction = {
  available: boolean;
  reason: string | null;
};

export type NativeFieldActivityType = "TRAVEL" | "MATERIAL_PICKUP";

export type NativeJobRunningTime = {
  running: boolean;
  recorded: boolean;
  activityType: string | null;
  activityLabel: string | null;
  startedAt: string | null;
  startedAtLabel: string | null;
  endedAt: string | null;
  endedAtLabel: string | null;
  hours: number | null;
  hoursLabel: string | null;
};

export type NativeJobPhotoStage = "BEFORE" | "DURING" | "AFTER";

export type NativeJobPhoto = {
  id: string;
  stage: NativeJobPhotoStage;
  caption: string | null;
  createdAt: string;
  previewUrl: string | null;
  previewExpiresInSeconds: number | null;
};

export type NativeJobPhotoUploadAction = {
  available: boolean;
  reason: string | null;
  remaining: number;
  limit: number;
  count: number;
};

export type NativeJobVisitAction = {
  available: boolean;
  reason: string | null;
};

export type NativeJobChecklistItem = {
  key: string;
  title: string;
  required: boolean;
  checked: boolean;
};

export type NativeJobVisit = {
  eligible: true;
  outcomeStatus: string;
  outcomeLabel: string;
  cadenceLabel: string;
  procedureTitle: string | null;
  checklist: NativeJobChecklistItem[];
  recordCompleted: NativeJobVisitAction;
  recordReclean: NativeJobVisitAction;
};

export type NativeJobChecklist = {
  procedureTitle: string | null;
  items: NativeJobChecklistItem[];
};

export type NativeVisitOutcomeStatus = "VISIT_COMPLETED" | "RE_CLEAN_REQUESTED";

export type NativeJobPhotos = {
  items: NativeJobPhoto[];
  count: number;
  limit: number;
  remaining: number;
  truncated: boolean;
  truncatedNotice: string | null;
  upload: NativeJobPhotoUploadAction;
};

export type NativePickupException =
  | "UNAVAILABLE"
  | "SHORT"
  | "DAMAGED"
  | "CLOSED"
  | "OTHER";

export type NativeJobPickupItem = {
  id: string;
  name: string;
  quantityNeeded: string;
  unit: string;
  supplierName: string | null;
  pickupLocationDescription: string | null;
  pickupDurationMinutes: number | null;
  pickupReady: boolean;
  status: string;
  quantityPickedUp: string | null;
  pickupException: NativePickupException | string | null;
  pickupExceptionLabel: string | null;
  pickupExceptionNote: string | null;
  pickupRecorded: boolean;
};

export type NativeJobMilestone = {
  id: string;
  title: string;
  sortOrder: number;
  status: "OPEN" | "COMPLETED";
  statusLabel: string;
  recordedAt: string;
  recordedAtLabel: string;
  completedAt: string | null;
  completedAtLabel: string | null;
};

export type NativeJobMilestones = {
  items: NativeJobMilestone[];
  count: number;
  limit: number;
  truncated: boolean;
  truncatedNotice: string | null;
};

export type NativeJobDetail = NativeJobSummary & {
  customerPhone: string | null;
  callHref: string | null;
  directionsHref: string | null;
  confirmationLabel: string;
  accessLines: string[];
  scope: {
    source: "version" | "legacy-estimate" | "none";
    versionNumber: number | null;
    items: Array<{ description: string; quantity: string; type: string }>;
  };
  startAction: NativeJobStartAction;
  completeAction: NativeJobCompleteAction;
  stopTimeAction: NativeJobStopTimeAction;
  runningTime: NativeJobRunningTime;
  travelTime: NativeJobRunningTime;
  pickupTime: NativeJobRunningTime;
  startTravelAction: NativeJobActivityAction;
  stopTravelAction: NativeJobActivityAction;
  startPickupAction: NativeJobActivityAction;
  stopPickupAction: NativeJobActivityAction;
  pickupItems: NativeJobPickupItem[];
  photos: NativeJobPhotos;
  milestones: NativeJobMilestones;
  visit: NativeJobVisit | null;
  checklist: NativeJobChecklist | null;
};

export type NativeJobPhotoAuthorizePayload = {
  assetId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadMethod: "PUT";
  expiresInSeconds: number;
};

export type NativeAssignedStopExclusion = {
  jobId: string;
  customerName: string;
  reason: "NO_PROPERTY" | "FOREIGN_PROPERTY" | "INCOMPLETE_ADDRESS" | "OVER_CAP";
  label: string;
};

export type NativeAssignedStopsMaps = {
  href: string | null;
  label: string;
  disclaimer: string;
  orderNote: string;
  includedStopCount: number;
  omittedCompleteStopCount: number;
  truncated: boolean;
  truncatedNotice: string | null;
  excludedHeading: string;
  excluded: NativeAssignedStopExclusion[];
  emptyMessage: string | null;
};

export type NativeTodayPayload = {
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  timeZone: string;
  today: NativeJobSummary[];
  upcoming: NativeJobSummary[];
  completed: NativeJobSummary[];
  truncated: boolean;
  limit: number;
  truncatedNotice: string | null;
  assignedStops: NativeAssignedStopsMaps;
};

export type NativeTimeCorrectionStatus = "PENDING" | "ACCEPTED" | "DECLINED";

export type NativeTimeCardEntry = {
  id: string;
  activityLabel: string;
  jobLabel: string | null;
  clockLabel: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  canRequest: boolean;
  blockedReason: string | null;
  requestStatus: NativeTimeCorrectionStatus | null;
  requestStatusLabel: string | null;
  requestReason: string | null;
  proposedClockLabel: string | null;
};

export type NativeTimeCardsPayload = {
  viewer: NativeViewer;
  workspace: NativeWorkspace;
  timeZone: string;
  entries: NativeTimeCardEntry[];
};

export type NativeSessionPayload = {
  session: { token: string; expiresAt: string };
  viewer: NativeViewer;
  workspace: NativeWorkspace;
};
