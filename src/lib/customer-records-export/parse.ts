import {
  CUSTOMER_RECORDS_EXPORT_CONTRACT,
  CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
  CUSTOMER_RECORDS_EXPORT_OMISSIONS,
  CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
  CUSTOMER_RECORDS_EXPORT_PRODUCT,
  CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
  CUSTOMER_RECORDS_EXPORT_SYSTEM,
  CUSTOMER_RECORDS_EXPORT_VERSION,
  PRIVATE_FILE_OMISSION,
  type CustomerRecordsExportCollection,
  type CustomerRecordsExportCustomerPacket,
  type CustomerRecordsExportDocument,
  type CustomerRecordsExportFileKind,
  type CustomerRecordsExportFileRef,
} from "@/lib/customer-records-export/contract";
import {
  CustomerRecordsExportError,
  invalidCustomerRecordsExportError,
} from "@/lib/customer-records-export/access";

const FILE_KINDS = new Set<CustomerRecordsExportFileKind>(["REQUEST_PHOTO", "JOB_PHOTO"]);
const FORBIDDEN_FILE_KEYS = ["url", "storageKey", "storageAccount", "body", "bytes", "content"];
const FORBIDDEN_PROPERTY_KEYS = [
  "accessCode",
  "accessCodes",
  "entryInstructions",
  "propertyAccessInstructions",
  "propertyAccessContactInfo",
  "propertyAccessPickupLocation",
  "propertyAccessNote",
  "keyLocation",
  "gateCode",
  "lockboxCode",
  "publicToken",
  "projectToken",
  "storageKey",
  "url",
];
const FORBIDDEN_ADDRESS_KEYS = [
  "accessCode",
  "entryInstructions",
  "keyLocation",
  "storageKey",
  "url",
];

export function serializeCustomerRecordsExport(document: CustomerRecordsExportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseCustomerRecordsExport(input: unknown): CustomerRecordsExportDocument {
  const value = asObject(input, "export document");
  const contract = asExactString(value.contract, CUSTOMER_RECORDS_EXPORT_CONTRACT, "contract");
  const version = asExactNumber(value.version, CUSTOMER_RECORDS_EXPORT_VERSION, "version");
  const exportedAt = asIsoDate(value.exportedAt, "exportedAt");
  const source = parseSource(value.source);
  const limits = parseLimits(value.limits);
  const authorization = parseAuthorization(value.authorization);
  const provenance = parseProvenance(value.provenance);
  const business = parseBusiness(value.business);
  const customers = parseCustomers(value.customers, provenance.page);
  const omitted = parseOmitted(value.omitted);

  if (provenance.businessId !== business.id) {
    throw invalid("provenance.businessId must match business.id");
  }

  return {
    contract,
    version,
    exportedAt,
    source,
    limits,
    authorization,
    provenance,
    business,
    customers,
    omitted,
  };
}

function parseSource(input: unknown): CustomerRecordsExportDocument["source"] {
  const value = asObject(input, "source");
  return {
    system: asExactString(value.system, CUSTOMER_RECORDS_EXPORT_SYSTEM, "source.system"),
    product: asExactString(value.product, CUSTOMER_RECORDS_EXPORT_PRODUCT, "source.product"),
  };
}

function parseLimits(input: unknown): CustomerRecordsExportDocument["limits"] {
  const value = asObject(input, "limits");
  if (value.liveSynchronization !== false) {
    throw invalid("limits.liveSynchronization must be false");
  }
  if (value.sharedDatabase !== false) {
    throw invalid("limits.sharedDatabase must be false");
  }
  if (value.writesOtherRepositories !== false) {
    throw invalid("limits.writesOtherRepositories must be false");
  }
  return {
    customerPageSize: asExactNumber(
      value.customerPageSize,
      CUSTOMER_RECORDS_EXPORT_PAGE_SIZE,
      "limits.customerPageSize",
    ),
    relatedRecordLimit: asExactNumber(
      value.relatedRecordLimit,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      "limits.relatedRecordLimit",
    ),
    fileReferenceLimit: asExactNumber(
      value.fileReferenceLimit,
      CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
      "limits.fileReferenceLimit",
    ),
    liveSynchronization: false,
    sharedDatabase: false,
    writesOtherRepositories: false,
  };
}

function parseAuthorization(input: unknown): CustomerRecordsExportDocument["authorization"] {
  const value = asObject(input, "authorization");
  return {
    role: asExactString(value.role, "OWNER", "authorization.role"),
    authorizedByMembershipId: asNonEmptyString(
      value.authorizedByMembershipId,
      "authorization.authorizedByMembershipId",
    ),
  };
}

function parseProvenance(input: unknown): CustomerRecordsExportDocument["provenance"] {
  const value = asObject(input, "provenance");
  const page = asObject(value.page, "provenance.page");
  const limit = asExactNumber(page.limit, CUSTOMER_RECORDS_EXPORT_PAGE_SIZE, "provenance.page.limit");
  const count = asNonNegativeInteger(page.count, "provenance.page.count");
  const truncated = asBoolean(page.truncated, "provenance.page.truncated");
  if (count > limit) {
    throw invalid("provenance.page.count cannot exceed the customer page size");
  }
  if (truncated && count !== limit) {
    throw invalid("truncated customer pages must fill the customer page size");
  }
  return {
    businessId: asNonEmptyString(value.businessId, "provenance.businessId"),
    page: {
      limit,
      count,
      truncated,
      cursor: asNullableString(page.cursor, "provenance.page.cursor"),
      nextCursor: asNullableString(page.nextCursor, "provenance.page.nextCursor"),
      customerId: asNullableString(page.customerId, "provenance.page.customerId"),
    },
  };
}

function parseBusiness(input: unknown): CustomerRecordsExportDocument["business"] {
  const value = asObject(input, "business");
  return {
    id: asNonEmptyString(value.id, "business.id"),
    name: asString(value.name, "business.name"),
    slug: asNonEmptyString(value.slug, "business.slug"),
    tradeCode: asNonEmptyString(value.tradeCode, "business.tradeCode"),
  };
}

function parseCustomers(
  input: unknown,
  page: CustomerRecordsExportDocument["provenance"]["page"],
): CustomerRecordsExportCustomerPacket[] {
  if (!Array.isArray(input)) {
    throw invalid("customers must be an array");
  }
  if (input.length !== page.count) {
    throw invalid("customers length must match provenance.page.count");
  }
  if (page.customerId && (input.length !== 1 || packetCustomerId(input[0]) !== page.customerId)) {
    throw invalid("single-customer export must contain exactly that customer");
  }
  return input.map((item, index) => parseCustomerPacket(item, index));
}

function packetCustomerId(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const customer = (input as { customer?: unknown }).customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer)) return null;
  const id = (customer as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function parseCustomerPacket(input: unknown, index: number): CustomerRecordsExportCustomerPacket {
  const value = asObject(input, `customers[${index}]`);
  const customer = parseCustomer(value.customer, index);
  return {
    customer,
    properties: parseCollection(
      value.properties,
      `customers[${index}].properties`,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      (item, itemIndex) => parseProperty(item, index, itemIndex, customer.id),
    ),
    requests: parseCollection(
      value.requests,
      `customers[${index}].requests`,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      (item, itemIndex) => parseRequest(item, index, itemIndex, customer.id),
    ),
    estimates: parseCollection(
      value.estimates,
      `customers[${index}].estimates`,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      (item, itemIndex) => parseEstimate(item, index, itemIndex, customer.id),
    ),
    jobs: parseCollection(
      value.jobs,
      `customers[${index}].jobs`,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      (item, itemIndex) => parseJob(item, index, itemIndex, customer.id),
    ),
    invoices: parseCollection(
      value.invoices,
      `customers[${index}].invoices`,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      (item, itemIndex) => parseInvoice(item, index, itemIndex, customer.id),
    ),
    payments: parseCollection(
      value.payments,
      `customers[${index}].payments`,
      CUSTOMER_RECORDS_EXPORT_RELATED_LIMIT,
      (item, itemIndex) => parsePayment(item, index, itemIndex, customer.id),
    ),
    files: parseCollection(
      value.files,
      `customers[${index}].files`,
      CUSTOMER_RECORDS_EXPORT_FILE_LIMIT,
      (item, itemIndex) => parseFileRef(item, index, itemIndex),
    ),
  };
}

function parseCustomer(input: unknown, index: number): CustomerRecordsExportCustomerPacket["customer"] {
  const value = asObject(input, `customers[${index}].customer`);
  return {
    id: asNonEmptyString(value.id, `customers[${index}].customer.id`),
    name: asString(value.name, `customers[${index}].customer.name`),
    email: asNullableString(value.email, `customers[${index}].customer.email`),
    phone: asNullableString(value.phone, `customers[${index}].customer.phone`),
    smsConsentStatus: asNonEmptyString(
      value.smsConsentStatus,
      `customers[${index}].customer.smsConsentStatus`,
    ),
    firstLeadSource: asNullableString(
      value.firstLeadSource,
      `customers[${index}].customer.firstLeadSource`,
    ),
    createdAt: asIsoDate(value.createdAt, `customers[${index}].customer.createdAt`),
    updatedAt: asIsoDate(value.updatedAt, `customers[${index}].customer.updatedAt`),
  };
}

function parseCollection<T>(
  input: unknown,
  label: string,
  expectedLimit: number,
  parseItem: (item: unknown, index: number) => T,
): CustomerRecordsExportCollection<T> {
  const value = asObject(input, label);
  const count = asNonNegativeInteger(value.count, `${label}.count`);
  const truncated = asBoolean(value.truncated, `${label}.truncated`);
  const limit = asExactNumber(value.limit, expectedLimit, `${label}.limit`);
  if (!Array.isArray(value.items)) {
    throw invalid(`${label}.items must be an array`);
  }
  if (value.items.length !== count) {
    throw invalid(`${label}.count must match ${label}.items length`);
  }
  if (count > limit) {
    throw invalid(`${label}.count cannot exceed the collection limit`);
  }
  if (truncated && count !== limit) {
    throw invalid(`truncated ${label} must fill the collection limit`);
  }
  return {
    count,
    truncated,
    limit,
    items: value.items.map((item, itemIndex) => parseItem(item, itemIndex)),
  };
}

function parseProperty(
  input: unknown,
  customerIndex: number,
  index: number,
  customerId: string,
): CustomerRecordsExportDocument["customers"][number]["properties"]["items"][number] {
  const label = `customers[${customerIndex}].properties.items[${index}]`;
  const value = asObject(input, label);
  assertAbsent(value, `${label}`, FORBIDDEN_PROPERTY_KEYS);
  const addressValue = asObject(value.address, `${label}.address`);
  assertAbsent(addressValue, `${label}.address`, FORBIDDEN_ADDRESS_KEYS);
  const property = {
    id: asNonEmptyString(value.id, `${label}.id`),
    customerId: asNonEmptyString(value.customerId, `${label}.customerId`),
    label: asNullableString(value.label, `${label}.label`),
    address: {
      addressLine1: asNonEmptyString(addressValue.addressLine1, `${label}.address.addressLine1`),
      addressLine2: asNullableString(addressValue.addressLine2, `${label}.address.addressLine2`),
      city: asNullableString(addressValue.city, `${label}.address.city`),
      region: asNullableString(addressValue.region, `${label}.address.region`),
      postalCode: asNullableString(addressValue.postalCode, `${label}.address.postalCode`),
    },
    createdAt: asIsoDate(value.createdAt, `${label}.createdAt`),
    updatedAt: asIsoDate(value.updatedAt, `${label}.updatedAt`),
  };
  if (property.customerId !== customerId) {
    throw invalid(`${label}.customerId must match the parent customer`);
  }
  return property;
}

function parseRequest(
  input: unknown,
  customerIndex: number,
  index: number,
  customerId: string,
): CustomerRecordsExportDocument["customers"][number]["requests"]["items"][number] {
  const label = `customers[${customerIndex}].requests.items[${index}]`;
  const value = asObject(input, label);
  const request = {
    id: asNonEmptyString(value.id, `${label}.id`),
    customerId: asNonEmptyString(value.customerId, `${label}.customerId`),
    propertyId: asNullableString(value.propertyId, `${label}.propertyId`),
    status: asNonEmptyString(value.status, `${label}.status`),
    summary: asNullableString(value.summary, `${label}.summary`),
    description: asNullableString(value.description, `${label}.description`),
    leadSource: asNullableString(value.leadSource, `${label}.leadSource`),
    serviceIntent: asNonEmptyString(value.serviceIntent, `${label}.serviceIntent`),
    createdAt: asIsoDate(value.createdAt, `${label}.createdAt`),
    updatedAt: asIsoDate(value.updatedAt, `${label}.updatedAt`),
  };
  if (request.customerId !== customerId) {
    throw invalid(`${label}.customerId must match the parent customer`);
  }
  return request;
}

function parseEstimate(
  input: unknown,
  customerIndex: number,
  index: number,
  customerId: string,
): CustomerRecordsExportDocument["customers"][number]["estimates"]["items"][number] {
  const label = `customers[${customerIndex}].estimates.items[${index}]`;
  const value = asObject(input, label);
  assertAbsent(value, `${label}`, ["publicToken"]);
  const estimate = {
    id: asNonEmptyString(value.id, `${label}.id`),
    customerId: asNonEmptyString(value.customerId, `${label}.customerId`),
    propertyId: asNullableString(value.propertyId, `${label}.propertyId`),
    serviceRequestId: asNullableString(value.serviceRequestId, `${label}.serviceRequestId`),
    status: asNonEmptyString(value.status, `${label}.status`),
    total: asMoney(value.total, `${label}.total`),
    createdAt: asIsoDate(value.createdAt, `${label}.createdAt`),
    updatedAt: asIsoDate(value.updatedAt, `${label}.updatedAt`),
  };
  if (estimate.customerId !== customerId) {
    throw invalid(`${label}.customerId must match the parent customer`);
  }
  return estimate;
}

function parseJob(
  input: unknown,
  customerIndex: number,
  index: number,
  customerId: string,
): CustomerRecordsExportDocument["customers"][number]["jobs"]["items"][number] {
  const label = `customers[${customerIndex}].jobs.items[${index}]`;
  const value = asObject(input, label);
  assertAbsent(value, `${label}`, [
    "projectToken",
    "propertyAccessInstructions",
    "propertyAccessContactInfo",
    "propertyAccessPickupLocation",
    "propertyAccessNote",
  ]);
  const job = {
    id: asNonEmptyString(value.id, `${label}.id`),
    customerId: asNonEmptyString(value.customerId, `${label}.customerId`),
    propertyId: asNullableString(value.propertyId, `${label}.propertyId`),
    estimateId: asNullableString(value.estimateId, `${label}.estimateId`),
    status: asNonEmptyString(value.status, `${label}.status`),
    scheduledAt: asNullableIsoDate(value.scheduledAt, `${label}.scheduledAt`),
    serviceIntent: asNonEmptyString(value.serviceIntent, `${label}.serviceIntent`),
    createdAt: asIsoDate(value.createdAt, `${label}.createdAt`),
    updatedAt: asIsoDate(value.updatedAt, `${label}.updatedAt`),
  };
  if (job.customerId !== customerId) {
    throw invalid(`${label}.customerId must match the parent customer`);
  }
  return job;
}

function parseInvoice(
  input: unknown,
  customerIndex: number,
  index: number,
  customerId: string,
): CustomerRecordsExportDocument["customers"][number]["invoices"]["items"][number] {
  const label = `customers[${customerIndex}].invoices.items[${index}]`;
  const value = asObject(input, label);
  const invoice = {
    id: asNonEmptyString(value.id, `${label}.id`),
    customerId: asNonEmptyString(value.customerId, `${label}.customerId`),
    jobId: asNullableString(value.jobId, `${label}.jobId`),
    kind: asNonEmptyString(value.kind, `${label}.kind`),
    status: asNonEmptyString(value.status, `${label}.status`),
    total: asMoney(value.total, `${label}.total`),
    paidAt: asNullableIsoDate(value.paidAt, `${label}.paidAt`),
    paymentMethod: asNullableString(value.paymentMethod, `${label}.paymentMethod`),
    paymentReference: asNullableString(value.paymentReference, `${label}.paymentReference`),
    createdAt: asIsoDate(value.createdAt, `${label}.createdAt`),
    updatedAt: asIsoDate(value.updatedAt, `${label}.updatedAt`),
  };
  if (invoice.customerId !== customerId) {
    throw invalid(`${label}.customerId must match the parent customer`);
  }
  return invoice;
}

function parsePayment(
  input: unknown,
  customerIndex: number,
  index: number,
  customerId: string,
): CustomerRecordsExportDocument["customers"][number]["payments"]["items"][number] {
  const label = `customers[${customerIndex}].payments.items[${index}]`;
  const value = asObject(input, label);
  assertAbsent(value, `${label}`, ["stripeCheckoutSessionId", "stripePaymentIntentId"]);
  const payment = {
    id: asNonEmptyString(value.id, `${label}.id`),
    customerId: asNonEmptyString(value.customerId, `${label}.customerId`),
    estimateId: asNullableString(value.estimateId, `${label}.estimateId`),
    jobId: asNullableString(value.jobId, `${label}.jobId`),
    invoiceId: asNullableString(value.invoiceId, `${label}.invoiceId`),
    purpose: asNonEmptyString(value.purpose, `${label}.purpose`),
    amount: asMoney(value.amount, `${label}.amount`),
    method: asNonEmptyString(value.method, `${label}.method`),
    receivedAt: asIsoDate(value.receivedAt, `${label}.receivedAt`),
    note: asNullableString(value.note, `${label}.note`),
    createdAt: asIsoDate(value.createdAt, `${label}.createdAt`),
  };
  if (payment.customerId !== customerId) {
    throw invalid(`${label}.customerId must match the parent customer`);
  }
  return payment;
}

function parseFileRef(
  input: unknown,
  customerIndex: number,
  index: number,
): CustomerRecordsExportFileRef {
  const label = `customers[${customerIndex}].files.items[${index}]`;
  const value = asObject(input, label);
  assertAbsent(value, `${label}`, FORBIDDEN_FILE_KEYS);
  const kind = asNonEmptyString(value.kind, `${label}.kind`);
  if (!FILE_KINDS.has(kind as CustomerRecordsExportFileKind)) {
    throw invalid(`${label}.kind must be a known private-file reference kind`);
  }
  const status = asNonEmptyString(value.status, `${label}.status`);
  if (status !== "REFERENCE" && status !== "OMITTED") {
    throw invalid(`${label}.status must be REFERENCE or OMITTED`);
  }
  return {
    id: asNonEmptyString(value.id, `${label}.id`),
    kind: kind as CustomerRecordsExportFileKind,
    relatedRequestId: asNullableString(value.relatedRequestId, `${label}.relatedRequestId`),
    relatedJobId: asNullableString(value.relatedJobId, `${label}.relatedJobId`),
    originalFilename: asNullableString(value.originalFilename, `${label}.originalFilename`),
    mimeType: asNullableString(value.mimeType, `${label}.mimeType`),
    visibility: asNullableString(value.visibility, `${label}.visibility`),
    status,
    omission: asExactString(value.omission, PRIVATE_FILE_OMISSION, `${label}.omission`),
  };
}

function parseOmitted(input: unknown): readonly string[] {
  if (!Array.isArray(input)) {
    throw invalid("omitted must be an array");
  }
  const omitted = input.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw invalid(`omitted[${index}] must be a non-empty string`);
    }
    return item;
  });
  for (const required of CUSTOMER_RECORDS_EXPORT_OMISSIONS) {
    if (!omitted.includes(required)) {
      throw invalid("omitted must retain the contract's remaining limits");
    }
  }
  return omitted;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw invalid(`${label} must be a string`);
  }
  return value;
}

function asNonEmptyString(value: unknown, label: string): string {
  const text = asString(value, label).trim();
  if (!text) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return text;
}

function asNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return asString(value, label);
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`${label} must be a boolean`);
  }
  return value;
}

function asExactString<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw invalid(`${label} must be ${expected}`);
  }
  return expected;
}

function asExactNumber<T extends number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw invalid(`${label} must be ${expected}`);
  }
  return expected;
}

function asNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function asIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw invalid(`${label} must be an ISO date string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalid(`${label} must be an ISO date string`);
  }
  return date.toISOString();
}

function asNullableIsoDate(value: unknown, label: string): string | null {
  if (value === null) return null;
  return asIsoDate(value, label);
}

function asMoney(value: unknown, label: string): string {
  const text = asString(value, label);
  if (!/^-?\d+\.\d{2}$/.test(text)) {
    throw invalid(`${label} must be a two-decimal money string`);
  }
  return text;
}

function assertAbsent(value: Record<string, unknown>, label: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (key in value) {
      throw invalid(`${label} must not include ${key}`);
    }
  }
}

function invalid(message: string): CustomerRecordsExportError {
  return invalidCustomerRecordsExportError(message);
}
