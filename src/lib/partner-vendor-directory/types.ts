import type {
  DirectoryKind,
  DirectoryReviewStatus,
  DirectorySource,
} from "@/lib/partner-vendor-directory/constants";

export type DirectoryQuery = {
  q: string;
  kind: DirectoryKind | "all";
  source: DirectorySource | "all";
  review: DirectoryReviewStatus | "all";
  selected: string;
};

export type DirectoryLinkableSupplier = {
  id: string;
  name: string;
  active: boolean;
};

export type DirectoryLinkableReferral = {
  id: string;
  label: string;
  notes: string;
};

export type DirectoryOpportunityView = {
  id: string;
  kind: DirectoryKind;
  kindLabel: string;
  name: string;
  summary: string;
  notes: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  category: string | null;
  locationDescription: string | null;
  source: DirectorySource;
  sourceLabel: string;
  reviewStatus: DirectoryReviewStatus;
  reviewLabel: string;
  needsReview: boolean;
  supplierId: string | null;
  supplierName: string | null;
  referralId: string | null;
  referralLabel: string | null;
  reviewNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastReviewedAt: Date | null;
};

export type DirectoryWorkspace = {
  query: DirectoryQuery;
  opportunities: DirectoryOpportunityView[];
  selected: DirectoryOpportunityView | null;
  linkableSuppliers: DirectoryLinkableSupplier[];
  linkableReferrals: DirectoryLinkableReferral[];
  counts: {
    total: number;
    pendingReview: number;
    partners: number;
    vendors: number;
  };
  limitsMessage: string;
  searchMessage: string;
  linkMessage: string;
};
