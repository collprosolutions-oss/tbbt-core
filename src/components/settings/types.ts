import type {
  SettingsCustomerExportRow,
  SettingsSnapshot,
  SettingsTeamMember,
} from "@/lib/settings-data";
import type {
  IntegrationCard,
  SettingsPreferenceFlags,
  SettingsReadiness,
  SettingsSection,
} from "@/lib/settings";

export type SettingsWorkspaceProps = {
  section: SettingsSection;
  role: "OWNER" | "ADMIN" | "MEMBER";
  snapshot: SettingsSnapshot;
  readiness: SettingsReadiness;
  integrations: IntegrationCard[];
  canEditConsequential: boolean;
  canEditPreferences: boolean;
};

export type {
  IntegrationCard,
  SettingsCustomerExportRow,
  SettingsPreferenceFlags,
  SettingsReadiness,
  SettingsSection,
  SettingsSnapshot,
  SettingsTeamMember,
};
