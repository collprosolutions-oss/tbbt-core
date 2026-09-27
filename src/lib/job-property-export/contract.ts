/**
 * Versioned completed job/property export contract.
 *
 * This is an OWNER-authorized snapshot of recorded TBBT facts for one
 * same-business completed job and its property. It is a portable JSON
 * packet for possible future HQ Watchfolio or REIOS use.
 *
 * It is not live synchronization, not a shared database, and it does not
 * write into any other repository.
 */

export const JOB_PROPERTY_EXPORT_CONTRACT = "tbbt.completed-job-property.v1" as const;
export const JOB_PROPERTY_EXPORT_VERSION = 1;
export const JOB_PROPERTY_EXPORT_SYSTEM = "tbbt-core" as const;
export const JOB_PROPERTY_EXPORT_PRODUCT = "TBBT" as const;
export const JOB_PROPERTY_EXPORT_CONSUMER_INTEGRATION = "none" as const;

export const JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS = [
  "hq-watchfolio",
  "reios",
] as const;

export type JobPropertyExportIntendedConsumer =
  (typeof JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS)[number];

export const JOB_PROPERTY_EXPORT_OMISSIONS = [
  "Access codes, key locations, pickup instructions, and other property-access secrets",
  "Customer name, email, and phone unless the OWNER expressly authorizes private customer data",
  "Job photo URLs, captions, binaries, and storage credentials unless the OWNER expressly authorizes photos",
  "Invoices, payments, expenses, time cards, and other financial records",
  "Live synchronization with HQ Watchfolio or REIOS",
  "Shared-database writes or reads outside tbbt-core",
  "Writes into HQ Watchfolio, REIOS, or any other repository",
] as const;

export type JobPropertyExportAuthorizationOptions = {
  includePrivateCustomer: boolean;
  includePhotos: boolean;
};

export type JobPropertyExportSource = {
  system: typeof JOB_PROPERTY_EXPORT_SYSTEM;
  product: typeof JOB_PROPERTY_EXPORT_PRODUCT;
};

export type JobPropertyExportLimits = {
  liveSynchronization: false;
  sharedDatabase: false;
  writesOtherRepositories: false;
  consumerIntegration: typeof JOB_PROPERTY_EXPORT_CONSUMER_INTEGRATION;
  intendedFutureConsumers: readonly JobPropertyExportIntendedConsumer[];
};

export type JobPropertyExportAuthorization = {
  role: "OWNER";
  authorizedByMembershipId: string;
  includePrivateCustomer: boolean;
  includePhotos: boolean;
};

export type JobPropertyExportProvenance = {
  businessId: string;
  jobId: string;
  propertyId: string;
  customerId: string | null;
  sourceRecordUpdatedAt: {
    job: string;
    property: string;
    customer: string | null;
  };
};

export type JobPropertyExportBusiness = {
  id: string;
  name: string;
  slug: string;
  tradeCode: string;
};

export type JobPropertyExportJob = {
  id: string;
  status: "COMPLETED";
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  serviceIntent: string;
  estimateId: string | null;
};

export type JobPropertyExportProperty = {
  id: string;
  label: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobPropertyExportCustomer = {
  included: boolean;
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
};

export type JobPropertyExportPhoto = {
  id: string;
  stage: string;
  caption: string | null;
  createdAt: string;
  marketingPermissionStatus: string;
  url: string | null;
};

export type JobPropertyExportPhotos = {
  included: boolean;
  count: number;
  items: JobPropertyExportPhoto[];
};

export type JobPropertyExportDocument = {
  contract: typeof JOB_PROPERTY_EXPORT_CONTRACT;
  version: typeof JOB_PROPERTY_EXPORT_VERSION;
  exportedAt: string;
  source: JobPropertyExportSource;
  limits: JobPropertyExportLimits;
  authorization: JobPropertyExportAuthorization;
  provenance: JobPropertyExportProvenance;
  business: JobPropertyExportBusiness;
  job: JobPropertyExportJob;
  property: JobPropertyExportProperty;
  customer: JobPropertyExportCustomer;
  photos: JobPropertyExportPhotos;
  omitted: readonly string[];
};

export function defaultJobPropertyExportLimits(): JobPropertyExportLimits {
  return {
    liveSynchronization: false,
    sharedDatabase: false,
    writesOtherRepositories: false,
    consumerIntegration: JOB_PROPERTY_EXPORT_CONSUMER_INTEGRATION,
    intendedFutureConsumers: [...JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS],
  };
}

export function jobPropertyExportFilename(document: JobPropertyExportDocument): string {
  const date = document.exportedAt.slice(0, 10) || "undated";
  const jobRef = document.job.id.slice(0, 8);
  return `tbbt-completed-job-property-v${document.version}-${jobRef}-${date}.json`;
}
