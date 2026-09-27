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
  completeAction: NativeJobCompleteAction;
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
};

export type NativeSessionPayload = {
  session: { token: string; expiresAt: string };
  viewer: NativeViewer;
  workspace: NativeWorkspace;
};
