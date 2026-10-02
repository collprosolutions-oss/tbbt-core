/**
 * Versioned OWNER-only customer-records export contract.
 *
 * This is a tenant-scoped portable JSON snapshot of recorded customers
 * and their same-business properties (with structured addresses),
 * requests, estimates, jobs, invoices, payments, invoice credits, and
 * time cards. Large exports are paginated. Private files stay permitted
 * references or a labeled omission — bytes and storage credentials are
 * never included.
 *
 * It is not the Settings business ZIP, not the customers-page CSV, not
 * live synchronization, and not a shared database.
 */

export const CUSTOMER_RECORDS_EXPORT_CONTRACT = "tbbt.customer-records.v1" as const;
export const CUSTOMER_RECORDS_EXPORT_VERSION = 1;
export const CUSTOMER_RECORDS_EXPORT_SYSTEM = "tbbt-core" as const;
export const CUSTOMER_RECORDS_EXPORT_PRODUCT = "TBBT" as const;

export const CUSTOMER_RECORDS_EXPORT_PAGE_SIZE = 25;
export const CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT = 50;
export const CUSTOMER_RECORDS_EXPORT_FILE_LIMIT = 40;

export const CUSTOMER_RECORDS_EXPORT_AUDIT_AREA = "data-export" as const;
export const CUSTOMER_RECORDS_EXPORT_AUDIT_KEY = "customerRecordsExport" as const;

export const CUSTOMER_RECORDS_EXPORT_OMISSIONS = [
  "Password hashes, session tokens, TOTP secrets, and setup/reset tokens",
  "Estimate public tokens and job project portal tokens",
  "Stripe checkout session, payment-intent, and provider identifiers",
  "Property access codes, key locations, and pickup instructions",
  "Private file bytes, storage URLs, storage keys, and storage credentials",
  "Another business’s records",
  "Live synchronization or shared-database writes outside tbbt-core",
] as const;

export const PRIVATE_FILE_OMISSION =
  "Private file bytes, storage URLs, storage keys, and storage credentials are omitted. This row is a same-business reference only.";

export const CUSTOMER_RECORDS_EXPORT_PROJECT_DOCUMENT_PURPOSE =
  "project-portal-document" as const;

export type CustomerRecordsExportSource = {
  system: typeof CUSTOMER_RECORDS_EXPORT_SYSTEM;
  product: typeof CUSTOMER_RECORDS_EXPORT_PRODUCT;
};

export type CustomerRecordsExportLimits = {
  customerPageSize: typeof CUSTOMER_RECORDS_EXPORT_PAGE_SIZE;
  relatedRecordLimit: typeof CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT;
  fileReferenceLimit: typeof CUSTOMER_RECORDS_EXPORT_FILE_LIMIT;
  liveSynchronization: false;
  sharedDatabase: false;
  writesOtherRepositories: false;
};

export type CustomerRecordsExportAuthorization = {
  role: "OWNER";
  authorizedByMembershipId: string;
};

export type CustomerRecordsExportPage = {
  limit: number;
  count: number;
  truncated: boolean;
  cursor: string | null;
  nextCursor: string | null;
  customerId: string | null;
};

export type CustomerRecordsExportProvenance = {
  businessId: string;
  page: CustomerRecordsExportPage;
};

export type CustomerRecordsExportBusiness = {
  id: string;
  name: string;
  slug: string;
  tradeCode: string;
};

export type CustomerRecordsExportCollection<T> = {
  count: number;
  truncated: boolean;
  limit: number;
  items: T[];
};

export type CustomerRecordsExportCustomer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  smsConsentStatus: string;
  firstLeadSource: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecordsExportAddress = {
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
};

export type CustomerRecordsExportProperty = {
  id: string;
  customerId: string;
  label: string | null;
  address: CustomerRecordsExportAddress;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecordsExportRequest = {
  id: string;
  customerId: string;
  propertyId: string | null;
  status: string;
  summary: string | null;
  description: string | null;
  leadSource: string | null;
  serviceIntent: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecordsExportEstimate = {
  id: string;
  customerId: string;
  propertyId: string | null;
  serviceRequestId: string | null;
  status: string;
  total: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecordsExportJob = {
  id: string;
  customerId: string;
  propertyId: string | null;
  estimateId: string | null;
  status: string;
  scheduledAt: string | null;
  serviceIntent: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecordsExportInvoice = {
  id: string;
  customerId: string;
  jobId: string | null;
  kind: string;
  status: string;
  total: string;
  paidAt: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecordsExportCredit = {
  id: string;
  customerId: string | null;
  invoiceId: string;
  amount: string;
  reason: string;
  createdAt: string;
};

export type CustomerRecordsExportPayment = {
  id: string;
  customerId: string;
  estimateId: string | null;
  jobId: string | null;
  invoiceId: string | null;
  purpose: string;
  amount: string;
  method: string;
  receivedAt: string;
  note: string | null;
  createdAt: string;
};

export type CustomerRecordsExportTimeCard = {
  id: string;
  jobId: string | null;
  membershipId: string;
  activityType: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  note: string | null;
  source: string;
  createdAt: string;
};

export type CustomerRecordsExportFileKind = "REQUEST_PHOTO" | "JOB_PHOTO" | "PROJECT_DOCUMENT";

export type CustomerRecordsExportFileRef = {
  id: string;
  kind: CustomerRecordsExportFileKind;
  relatedRequestId: string | null;
  relatedJobId: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  visibility: string | null;
  status: "REFERENCE" | "OMITTED";
  omission: typeof PRIVATE_FILE_OMISSION;
};

export type CustomerRecordsExportCustomerPacket = {
  customer: CustomerRecordsExportCustomer;
  properties: CustomerRecordsExportCollection<CustomerRecordsExportProperty>;
  requests: CustomerRecordsExportCollection<CustomerRecordsExportRequest>;
  estimates: CustomerRecordsExportCollection<CustomerRecordsExportEstimate>;
  jobs: CustomerRecordsExportCollection<CustomerRecordsExportJob>;
  invoices: CustomerRecordsExportCollection<CustomerRecordsExportInvoice>;
  payments: CustomerRecordsExportCollection<CustomerRecordsExportPayment>;
  credits: CustomerRecordsExportCollection<CustomerRecordsExportCredit>;
  timeCards: CustomerRecordsExportCollection<CustomerRecordsExportTimeCard>;
  files: CustomerRecordsExportCollection<CustomerRecordsExportFileRef>;
};

export type CustomerRecordsExportDocument = {
  contract: typeof CUSTOMER_RECORDS_EXPORT_CONTRACT;
  version: typeof CUSTOMER_RECORDS_EXPORT_VERSION;
  exportedAt: string;
  source: CustomerRecordsExportSource;
  limits: CustomerRecordsExportLimits;
  authorization: CustomerRecordsExportAuthorization;
  provenance: CustomerRecordsExportProvenance;
  business: CustomerRecordsExportBusiness;
  customers: CustomerRecordsExportCustomerPacket[];
  omitted: readonly string[];
};

export function defaultCustomerRecordsExportLimits(): CustomerRecordsExportLimits {
  return {
    customerPageSize: CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
    relatedRecordLimit: CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
    fileReferenceLimit: CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
    liveSynchronization: false,
    sharedDatabase: false,
    writesOtherRepositories: false,
  };
}

export function customerRecordsExportFilename(document: CustomerRecordsExportDocument): string {
  const date = document.exportedAt.slice(0, 10) || "undated";
  const single = document.provenance.page.customerId?.slice(0, 8);
  const page = document.provenance.page.cursor?.slice(0, 8);
  const suffix = single ? `customer-${single}` : page ? `page-${page}` : "page-start";
  return `tbbt-customer-records-v${document.version}-${document.business.slug}-${suffix}-${date}.json`;
}

export function customerRecordsExportPageTruncationMessage(limit: number): string {
  return `This page includes at most ${limit} customers. Additional same-business customers were not loaded. Download the next page with the returned cursor.`;
}

export function customerRecordsExportRelatedTruncationMessage(kind: string, limit: number): string {
  return `${kind} are truncated at ${limit}. Additional same-customer records were not loaded.`;
}

export function customerRecordsExportPropertyTruncationMessage(limit: number): string {
  return customerRecordsExportRelatedTruncationMessage(
    "Same-business properties and structured addresses",
    limit,
  );
}

export function customerRecordsExportFileTruncationMessage(limit: number): string {
  return `Private file references are truncated at ${limit}. Additional files were not listed. File bytes were never exported.`;
}

export function customerRecordsExportTimeCardTruncationMessage(limit: number): string {
  return customerRecordsExportRelatedTruncationMessage("Time cards", limit);
}

export function customerRecordsExportCreditTruncationMessage(limit: number): string {
  return customerRecordsExportRelatedTruncationMessage("Invoice credits", limit);
}
