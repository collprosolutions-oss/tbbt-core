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
import type { SupplierPricingContextPayload } from "@/lib/material-pricing/types";
import type { TestDataCleanupPreview } from "@/lib/test-data-cleanup";

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
    storageUsage?: { usedBytes: number; limitBytes: number } | null;
    slots: PublicSiteImageEditorSlot[];
  };
  supplierPricing?: SupplierPricingContextPayload | null;
  canClearTestData?: boolean;
  testDataCleanupPreview?: TestDataCleanupPreview | null;
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
