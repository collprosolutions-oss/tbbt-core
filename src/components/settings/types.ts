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
import type { PublicSiteImageEditorSlot } from "@/lib/public-site-images";

export type SettingsWorkspaceProps = {
  section: SettingsSection;
  role: "OWNER" | "ADMIN" | "MEMBER";
  snapshot: SettingsSnapshot;
  readiness: SettingsReadiness;
  integrations: IntegrationCard[];
  canEditConsequential: boolean;
  canEditPreferences: boolean;
  websitePhotos?: {
    storageConfigured: boolean;
    slots: PublicSiteImageEditorSlot[];
  };
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
