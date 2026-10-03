export const NATIVE_PUSH_KINDS = ["JOB_ASSIGNED", "JOB_RESCHEDULED"] as const;
export type NativePushKind = (typeof NATIVE_PUSH_KINDS)[number];

export const NATIVE_PUSH_DELIVERY_STATUSES = [
  "PENDING",
  "SENT",
  "FAILED",
  "SUPPRESSED",
] as const;
export type NativePushDeliveryStatus = (typeof NATIVE_PUSH_DELIVERY_STATUSES)[number];

export const NATIVE_PUSH_PLATFORMS = ["ios", "android", "expo", "test"] as const;
export type NativePushPlatform = (typeof NATIVE_PUSH_PLATFORMS)[number];

export type NativePushAlertPayload = {
  kind: NativePushKind;
  jobId: string;
  title: string;
  body: string;
  informational: true;
  startsTime: false;
  acceptsAppointment: false;
};

export type NativePushSendInput = {
  businessId: string;
  membershipId: string;
  jobId: string;
  kind: NativePushKind;
  deviceId: string;
  tokenLast4: string;
  deviceToken: string;
  payload: NativePushAlertPayload;
};

export type NativePushSendResult =
  | { ok: true; status: "SENT"; providerMessageId: string }
  | { ok: false; status: "FAILED"; error: string; revokeDevice?: boolean };

export type NativePushProvider = {
  id: string;
  connected: boolean;
  send(input: NativePushSendInput): Promise<NativePushSendResult>;
};
