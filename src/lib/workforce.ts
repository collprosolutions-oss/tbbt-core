/**
 * Tenant-scoped workforce identity lives on Membership.
 *
 * This is not a second employee table and not an HR performance system.
 * Skills, progression, and scheduling status are practical dispatch
 * labels the owner records. No demographic or sensitive profiling.
 */
export const WORKFORCE_PROGRESSIONS = [
  "LEARNING",
  "CAPABLE",
  "LEAD_QUALIFIED",
] as const;
export type WorkforceProgression = (typeof WORKFORCE_PROGRESSIONS)[number];

export const DEFAULT_WORKFORCE_PROGRESSION: WorkforceProgression = "CAPABLE";

export const WORKFORCE_SKILLS = [
  { key: "general", label: "General handyman" },
  { key: "carpentry", label: "Carpentry" },
  { key: "plumbing", label: "Plumbing" },
  { key: "electrical", label: "Electrical" },
  { key: "painting", label: "Painting" },
  { key: "drywall", label: "Drywall" },
  { key: "flooring", label: "Flooring" },
  { key: "tile", label: "Tile" },
  { key: "assembly", label: "Assembly" },
  { key: "outdoor", label: "Outdoor / yard" },
  { key: "appliance", label: "Appliance" },
  { key: "helper", label: "Helper / labor" },
] as const;

export type WorkforceSkillKey = (typeof WORKFORCE_SKILLS)[number]["key"];

export const WORKFORCE_SKILL_KEYS = WORKFORCE_SKILLS.map((skill) => skill.key);

export const APPOINTMENT_MODES = ["EXACT", "WINDOW"] as const;
export type AppointmentMode = (typeof APPOINTMENT_MODES)[number];

export const BENCH_CONTACT_PREFERENCES = ["PHONE", "EMAIL", "TEXT", "OTHER"] as const;
export type BenchContactPreference = (typeof BENCH_CONTACT_PREFERENCES)[number];

export const OUTREACH_TASK_KINDS = ["STAFFING_SHORTAGE", "HELPER_NEEDED"] as const;
export type OutreachTaskKind = (typeof OUTREACH_TASK_KINDS)[number];

export const OUTREACH_TASK_STATUSES = ["DRAFT", "APPROVED", "DISMISSED", "DONE"] as const;
export type OutreachTaskStatus = (typeof OUTREACH_TASK_STATUSES)[number];

export const DEFAULT_FIRST_APPOINTMENT_MODE: AppointmentMode = "EXACT";
export const DEFAULT_LATER_APPOINTMENT_MODE: AppointmentMode = "WINDOW";
export const DEFAULT_ARRIVAL_WINDOW_MINUTES = 120;
export const DEFAULT_DAY_BEFORE_CUTOFF_HOURS = 24;
export const DEFAULT_PICKUP_MINUTES = 0;
export const DEFAULT_TRAVEL_PLACEHOLDER_MINUTES = 0;
export const DEFAULT_HELPER_THRESHOLD_MINUTES = 60;
export const DEFAULT_OVERLOAD_THRESHOLD_PERCENT = 90;
export const MAX_POLICY_MINUTES = 24 * 60;
export const MAX_CUTOFF_HOURS = 168;
export const MAX_OVERLOAD_PERCENT = 200;

export type SchedulingPolicy = {
  firstAppointmentMode: AppointmentMode;
  laterAppointmentMode: AppointmentMode;
  defaultArrivalWindowMinutes: number;
  dayBeforeChangeCutoffHours: number;
  defaultPickupMinutes: number;
  travelPlaceholderMinutes: number;
  helperRecommendationThresholdMinutes: number;
  overloadThresholdPercent: number;
};

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  firstAppointmentMode: DEFAULT_FIRST_APPOINTMENT_MODE,
  laterAppointmentMode: DEFAULT_LATER_APPOINTMENT_MODE,
  defaultArrivalWindowMinutes: DEFAULT_ARRIVAL_WINDOW_MINUTES,
  dayBeforeChangeCutoffHours: DEFAULT_DAY_BEFORE_CUTOFF_HOURS,
  defaultPickupMinutes: DEFAULT_PICKUP_MINUTES,
  travelPlaceholderMinutes: DEFAULT_TRAVEL_PLACEHOLDER_MINUTES,
  helperRecommendationThresholdMinutes: DEFAULT_HELPER_THRESHOLD_MINUTES,
  overloadThresholdPercent: DEFAULT_OVERLOAD_THRESHOLD_PERCENT,
};

export type WorkforceMemberRole = "OWNER" | "ADMIN" | "MEMBER";

export type WorkforceMember = {
  membershipId: string;
  name: string;
  role: WorkforceMemberRole;
  active: boolean;
  schedulingActive: boolean;
  progression: WorkforceProgression;
  maxDailyJobMinutes: number | null;
  preferredJobTypes: string[];
  allowedJobTypes: string[];
  workforceNotes: string;
  skills: Array<{ skillKey: string; proficiency: WorkforceProgression }>;
  weeklyAvailability: Array<{
    weekday: number;
    startMinutes: number;
    endMinutes: number;
  }>;
  exceptions: Array<{
    date: string;
    kind: "AVAILABLE" | "UNAVAILABLE";
    startMinutes: number | null;
    endMinutes: number | null;
  }>;
};

export function isAssignableFieldMember(member: Pick<WorkforceMember, "role" | "active">) {
  return member.role === "MEMBER" && member.active;
}

export type FillInBenchRecord = {
  id: string;
  displayName: string;
  contactPreference: BenchContactPreference;
  contactValue: string;
  skills: string[];
  availabilityNotes: string;
  approved: boolean;
  active: boolean;
  lastUsedAt: Date | null;
  notes: string;
  membershipId: string | null;
};

export function isWorkforceProgression(
  value: string | null | undefined,
): value is WorkforceProgression {
  return (WORKFORCE_PROGRESSIONS as readonly string[]).includes(value ?? "");
}

export function parseWorkforceProgression(
  value: string | null | undefined,
): WorkforceProgression {
  return isWorkforceProgression(value) ? value : DEFAULT_WORKFORCE_PROGRESSION;
}

export function progressionRank(value: WorkforceProgression): number {
  return WORKFORCE_PROGRESSIONS.indexOf(value);
}

export function progressionMeets(
  have: WorkforceProgression,
  required: WorkforceProgression | "",
): boolean {
  if (!required) return true;
  return progressionRank(have) >= progressionRank(required);
}

export function isWorkforceSkillKey(value: string): value is WorkforceSkillKey {
  return (WORKFORCE_SKILL_KEYS as readonly string[]).includes(value);
}

export function parseSkillList(raw: string | null | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0 && part.length <= 40),
    ),
  ];
}

export function serializeSkillList(skills: string[]): string {
  return [...new Set(skills.map((skill) => skill.trim().toLowerCase()).filter(Boolean))].join(",");
}

export function skillLabel(key: string): string {
  return WORKFORCE_SKILLS.find((skill) => skill.key === key)?.label ?? key;
}

export function parseAppointmentMode(
  value: string | null | undefined,
  fallback: AppointmentMode,
): AppointmentMode {
  return (APPOINTMENT_MODES as readonly string[]).includes(value ?? "")
    ? (value as AppointmentMode)
    : fallback;
}

export function parseBoundedInt(
  raw: string | number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

export function parseOptionalBoundedInt(
  raw: string | number | null | undefined,
  min: number,
  max: number,
): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

export class WorkforceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkforceValidationError";
  }
}

export function requireWorkforceProgression(value: string | null | undefined): WorkforceProgression {
  if (!isWorkforceProgression(value)) {
    throw new WorkforceValidationError("Choose Learning, Capable, or Lead-qualified.");
  }
  return value;
}

export function requireOptionalWorkforceProgression(
  value: string | null | undefined,
): WorkforceProgression | "" {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  return requireWorkforceProgression(raw);
}

export function requireWorkforceSkillKey(value: string): WorkforceSkillKey {
  if (!isWorkforceSkillKey(value)) {
    throw new WorkforceValidationError("Choose a recorded skill from the workforce catalog.");
  }
  return value;
}

export function requireAppointmentMode(value: string | null | undefined): AppointmentMode {
  if (!(APPOINTMENT_MODES as readonly string[]).includes(value ?? "")) {
    throw new WorkforceValidationError("First and later appointment modes must be Exact or Window.");
  }
  return value as AppointmentMode;
}

export function requireBenchContactPreference(value: string | null | undefined): BenchContactPreference {
  if (!(BENCH_CONTACT_PREFERENCES as readonly string[]).includes(value ?? "")) {
    throw new WorkforceValidationError("Choose a valid bench contact preference.");
  }
  return value as BenchContactPreference;
}

export function requireWeekday(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 6) {
    throw new WorkforceValidationError("Weekday must be Sunday (0) through Saturday (6).");
  }
  return value;
}

export function requireDayMinutesRange(startMinutes: number, endMinutes: number) {
  if (
    !Number.isInteger(startMinutes) ||
    !Number.isInteger(endMinutes) ||
    startMinutes < 0 ||
    endMinutes > MAX_POLICY_MINUTES ||
    startMinutes >= endMinutes
  ) {
    throw new WorkforceValidationError("Availability start must be before end, within the same day.");
  }
  return { startMinutes, endMinutes };
}

export function requireExceptionKind(value: string | null | undefined): "AVAILABLE" | "UNAVAILABLE" {
  if (value !== "AVAILABLE" && value !== "UNAVAILABLE") {
    throw new WorkforceValidationError("Availability exception must be available or unavailable.");
  }
  return value;
}

export function requireIsoDate(value: string | null | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new WorkforceValidationError("Choose a valid date.");
  }
  return value;
}

export function schedulingPolicyFromRow(
  row:
    | {
        firstAppointmentMode?: string | null;
        laterAppointmentMode?: string | null;
        defaultArrivalWindowMinutes?: number | null;
        dayBeforeChangeCutoffHours?: number | null;
        defaultPickupMinutes?: number | null;
        travelPlaceholderMinutes?: number | null;
        helperRecommendationThresholdMinutes?: number | null;
        overloadThresholdPercent?: number | null;
      }
    | null
    | undefined,
): SchedulingPolicy {
  if (!row) return { ...DEFAULT_SCHEDULING_POLICY };
  return {
    firstAppointmentMode: parseAppointmentMode(
      row.firstAppointmentMode,
      DEFAULT_FIRST_APPOINTMENT_MODE,
    ),
    laterAppointmentMode: parseAppointmentMode(
      row.laterAppointmentMode,
      DEFAULT_LATER_APPOINTMENT_MODE,
    ),
    defaultArrivalWindowMinutes: parseBoundedInt(
      row.defaultArrivalWindowMinutes,
      DEFAULT_ARRIVAL_WINDOW_MINUTES,
      0,
      MAX_POLICY_MINUTES,
    ),
    dayBeforeChangeCutoffHours: parseBoundedInt(
      row.dayBeforeChangeCutoffHours,
      DEFAULT_DAY_BEFORE_CUTOFF_HOURS,
      0,
      MAX_CUTOFF_HOURS,
    ),
    defaultPickupMinutes: parseBoundedInt(
      row.defaultPickupMinutes,
      DEFAULT_PICKUP_MINUTES,
      0,
      MAX_POLICY_MINUTES,
    ),
    travelPlaceholderMinutes: parseBoundedInt(
      row.travelPlaceholderMinutes,
      DEFAULT_TRAVEL_PLACEHOLDER_MINUTES,
      0,
      MAX_POLICY_MINUTES,
    ),
    helperRecommendationThresholdMinutes: parseBoundedInt(
      row.helperRecommendationThresholdMinutes,
      DEFAULT_HELPER_THRESHOLD_MINUTES,
      0,
      MAX_POLICY_MINUTES,
    ),
    overloadThresholdPercent: parseBoundedInt(
      row.overloadThresholdPercent,
      DEFAULT_OVERLOAD_THRESHOLD_PERCENT,
      1,
      MAX_OVERLOAD_PERCENT,
    ),
  };
}

export type AppointmentPosition = "first" | "later";
export type PickupKind = "known" | "configured" | "none";

export function scheduleLaneKey(assignedMembershipId?: string | null) {
  return assignedMembershipId ?? "unassigned";
}

export function appointmentPositionOnDay(input: {
  start: Date;
  jobId?: string;
  assignedMembershipId?: string | null;
  jobs: Array<{
    id: string;
    scheduledAt: Date | null;
    assignedMembershipId?: string | null;
    status?: string | null;
  }>;
  dateKey: (date: Date) => string;
}): AppointmentPosition {
  const lane = scheduleLaneKey(input.assignedMembershipId);
  const dayKey = input.dateKey(input.start);
  const peers = input.jobs.filter((job) => {
    if (!job.scheduledAt || job.status === "COMPLETED") return false;
    if (job.id === input.jobId) return false;
    if (input.dateKey(job.scheduledAt) !== dayKey) return false;
    return scheduleLaneKey(job.assignedMembershipId) === lane;
  });
  const earliestPeer = peers.reduce<Date | null>((earliest, job) => {
    if (!job.scheduledAt) return earliest;
    if (!earliest || job.scheduledAt.getTime() < earliest.getTime()) return job.scheduledAt;
    return earliest;
  }, null);
  if (earliestPeer && earliestPeer.getTime() < input.start.getTime()) return "later";
  return "first";
}

export function appointmentModeForPosition(
  position: AppointmentPosition,
  policy: SchedulingPolicy,
): AppointmentMode {
  return position === "later" ? policy.laterAppointmentMode : policy.firstAppointmentMode;
}

/** @deprecated Use appointmentPositionOnDay + appointmentModeForPosition. */
export function appointmentModeForJob(input: {
  alreadyScheduled?: boolean;
  position?: AppointmentPosition;
  policy: SchedulingPolicy;
}): AppointmentMode {
  if (input.position) return appointmentModeForPosition(input.position, input.policy);
  return input.policy.firstAppointmentMode;
}

/**
 * Pickup minutes for occupied-window math.
 *
 * Known = Job.pickupDurationMinutes > 0.
 * None = owner recorded 0 (no pickup).
 * Configured = null/omitted and the business default is > 0. That default
 * is an assumption, not a known supplier pickup.
 *
 * The independent Materials pickup-requirement API is not consumed here.
 * When that lands, resolve it before this helper and persist the known
 * minutes on the job. Do not invent supplier state in this branch.
 */
export function pickupMinutesForJob(
  jobPickupMinutes: number | null | undefined,
  policy: SchedulingPolicy,
): { minutes: number; kind: PickupKind } {
  if (jobPickupMinutes != null && jobPickupMinutes > 0) {
    return { minutes: jobPickupMinutes, kind: "known" };
  }
  if (jobPickupMinutes === 0) {
    return { minutes: 0, kind: "none" };
  }
  if (policy.defaultPickupMinutes > 0) {
    return { minutes: policy.defaultPickupMinutes, kind: "configured" };
  }
  return { minutes: 0, kind: "none" };
}

export function formatProgression(value: WorkforceProgression): string {
  if (value === "LEARNING") return "Learning";
  if (value === "LEAD_QUALIFIED") return "Lead-qualified";
  return "Capable";
}

export function dayBeforeCutoffPassed(input: {
  scheduledAt: Date;
  now: Date;
  cutoffHours: number;
}): boolean {
  if (input.cutoffHours <= 0) return false;
  const cutoffAt = new Date(input.scheduledAt.getTime() - input.cutoffHours * 60 * 60 * 1000);
  return input.now.getTime() >= cutoffAt.getTime();
}
