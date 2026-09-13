/**
 * Client-safe Clear Test Data copy and preview types.
 *
 * Keep this module free of Prisma / settings-ops so the Settings form can
 * import the confirmation phrase without bundling the server cleanup graph.
 */

export const CLEAR_TEST_DATA_CONFIRMATION = "CLEAR TEST DATA";

export type TestDataCleanupCounts = {
  customers: number;
  properties: number;
  serviceRequests: number;
  serviceRequestItems: number;
  serviceRequestPhotos: number;
  serviceRequestMeasurements: number;
  estimates: number;
  estimateVersions: number;
  jobs: number;
  jobPhotos: number;
  invoices: number;
  payments: number;
  lineItems: number;
  changeOrders: number;
  additionalWorkRequests: number;
  jobProblemReports: number;
  timeEntries: number;
  timesheetWeeks: number;
  payrollRuns: number;
  expenses: number;
  pipelineOpportunities: number;
  reviews: number;
  reviewRequests: number;
  marketingContents: number;
  operationalStoredAssets: number;
};

export type TestDataCleanupPreview = {
  businessId: string;
  confirmationPhrase: string;
  willDelete: TestDataCleanupCounts;
  willPreserve: string[];
};

export const TEST_DATA_CLEANUP_PRESERVE = [
  "Business / tenant record and ownership memberships",
  "Business profile, public contact, and labor-minimum settings",
  "Website configuration, About copy, and PublicSiteImage rows",
  "Service catalog and service pricing",
  "Estimating defaults, supplier preferences, mappings, and supplier prices",
  "Scheduling settings and unavailable dates",
  "Website / brand stored assets and R2 storage account",
  "Stripe Connect connected-account configuration",
  "Knowledge entries",
  "Settings audit history",
  "Team users, sessions, and founder design overrides",
] as const;
