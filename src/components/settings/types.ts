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
import type { TestDataCleanupPreview } from "@/lib/test-data-cleanup-constants";

export type SettingsWorkspaceProps = {
  section: SettingsSection;
  role: "OWNER" | "ADMIN" | "MEMBER";
  snapshot: SettingsSnapshot;
  readiness: SettingsReadiness;
  integrations: IntegrationCard[];
  canEditConsequential: boolean;
  canEditPreferences: boolean;
  canOperate: boolean;
  operatingBlockedMessage: string;
  websitePhotos?: {
    storageConfigured: boolean;
    storageUsage?: { usedBytes: number; limitBytes: number } | null;
    slots: PublicSiteImageEditorSlot[];
  };
  supplierPricing?: SupplierPricingContextPayload | null;
  canClearTestData?: boolean;
  testDataCleanupPreview?: TestDataCleanupPreview | null;
  checkoutStatus?: "success" | "canceled" | null;
  security?: {
    totpEnabled: boolean;
    totpEnabledAt: string | null;
    sessions: Array<{
      id: string;
      createdAt: string;
      expiresAt: string;
      userAgent: string | null;
      revokedAt: string | null;
      current: boolean;
      active: boolean;
    }>;
    ownershipCandidates: Array<{
      id: string;
      name: string;
      email: string;
      role: string;
    }>;
    offboardingRequestedAt: string | null;
    canTransferOwnership: boolean;
    canRequestOffboarding: boolean;
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
