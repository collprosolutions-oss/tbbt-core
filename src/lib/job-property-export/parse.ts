import {
  JOB_PROPERTY_EXPORT_CONSUMER_INTEGRATION,
  JOB_PROPERTY_EXPORT_CONTRACT,
  JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS,
  JOB_PROPERTY_EXPORT_OMISSIONS,
  JOB_PROPERTY_EXPORT_PRODUCT,
  JOB_PROPERTY_EXPORT_SYSTEM,
  JOB_PROPERTY_EXPORT_VERSION,
  type JobPropertyExportCustomer,
  type JobPropertyExportDocument,
  type JobPropertyExportIntendedConsumer,
  type JobPropertyExportPhoto,
} from "@/lib/job-property-export/contract";
import { JobPropertyExportError } from "@/lib/job-property-export/access";

export function serializeJobPropertyExport(document: JobPropertyExportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseJobPropertyExport(input: unknown): JobPropertyExportDocument {
  const value = asObject(input, "export document");
  const contract = asExactString(value.contract, JOB_PROPERTY_EXPORT_CONTRACT, "contract");
  const version = asExactNumber(value.version, JOB_PROPERTY_EXPORT_VERSION, "version");
  const exportedAt = asIsoDate(value.exportedAt, "exportedAt");
  const source = parseSource(value.source);
  const limits = parseLimits(value.limits);
  const authorization = parseAuthorization(value.authorization);
  const provenance = parseProvenance(value.provenance);
  const business = parseBusiness(value.business);
  const job = parseJob(value.job);
  const property = parseProperty(value.property);
  const customer = parseCustomer(value.customer, authorization.includePrivateCustomer);
  const photos = parsePhotos(value.photos, authorization.includePhotos);
  const omitted = parseOmitted(value.omitted);

  if (provenance.jobId !== job.id) {
    throw invalid("provenance.jobId must match job.id");
  }
  if (provenance.propertyId !== property.id) {
    throw invalid("provenance.propertyId must match property.id");
  }
  if (provenance.businessId !== business.id) {
    throw invalid("provenance.businessId must match business.id");
  }
  if (provenance.customerId !== customer.id) {
    throw invalid("provenance.customerId must match customer.id");
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
    job,
    property,
    customer,
    photos,
    omitted,
  };
}

function parseSource(input: unknown): JobPropertyExportDocument["source"] {
  const value = asObject(input, "source");
  return {
    system: asExactString(value.system, JOB_PROPERTY_EXPORT_SYSTEM, "source.system"),
    product: asExactString(value.product, JOB_PROPERTY_EXPORT_PRODUCT, "source.product"),
  };
}

function parseLimits(input: unknown): JobPropertyExportDocument["limits"] {
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
  const consumerIntegration = asExactString(
    value.consumerIntegration,
    JOB_PROPERTY_EXPORT_CONSUMER_INTEGRATION,
    "limits.consumerIntegration",
  );
  if (!Array.isArray(value.intendedFutureConsumers)) {
    throw invalid("limits.intendedFutureConsumers must be an array");
  }
  const intendedFutureConsumers = value.intendedFutureConsumers.map((item, index) => {
    if (typeof item !== "string") {
      throw invalid(`limits.intendedFutureConsumers[${index}] must be a string`);
    }
    if (
      !JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS.includes(item as JobPropertyExportIntendedConsumer)
    ) {
      throw invalid(`limits.intendedFutureConsumers[${index}] is not a known future consumer`);
    }
    return item as JobPropertyExportIntendedConsumer;
  });
  const uniqueConsumers = new Set(intendedFutureConsumers);
  if (
    uniqueConsumers.size !== JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS.length ||
    !JOB_PROPERTY_EXPORT_INTENDED_CONSUMERS.every((item) => uniqueConsumers.has(item))
  ) {
    throw invalid("limits.intendedFutureConsumers must list the known future consumers");
  }
  return {
    liveSynchronization: false,
    sharedDatabase: false,
    writesOtherRepositories: false,
    consumerIntegration,
    intendedFutureConsumers,
  };
}

function parseAuthorization(input: unknown): JobPropertyExportDocument["authorization"] {
  const value = asObject(input, "authorization");
  return {
    role: asExactString(value.role, "OWNER", "authorization.role"),
    authorizedByMembershipId: asNonEmptyString(
      value.authorizedByMembershipId,
      "authorization.authorizedByMembershipId",
    ),
    includePrivateCustomer: asBoolean(value.includePrivateCustomer, "authorization.includePrivateCustomer"),
    includePhotos: asBoolean(value.includePhotos, "authorization.includePhotos"),
  };
}

function parseProvenance(input: unknown): JobPropertyExportDocument["provenance"] {
  const value = asObject(input, "provenance");
  const updated = asObject(value.sourceRecordUpdatedAt, "provenance.sourceRecordUpdatedAt");
  return {
    businessId: asNonEmptyString(value.businessId, "provenance.businessId"),
    jobId: asNonEmptyString(value.jobId, "provenance.jobId"),
    propertyId: asNonEmptyString(value.propertyId, "provenance.propertyId"),
    customerId: asNullableString(value.customerId, "provenance.customerId"),
    sourceRecordUpdatedAt: {
      job: asIsoDate(updated.job, "provenance.sourceRecordUpdatedAt.job"),
      property: asIsoDate(updated.property, "provenance.sourceRecordUpdatedAt.property"),
      customer: asNullableIsoDate(updated.customer, "provenance.sourceRecordUpdatedAt.customer"),
    },
  };
}

function parseBusiness(input: unknown): JobPropertyExportDocument["business"] {
  const value = asObject(input, "business");
  return {
    id: asNonEmptyString(value.id, "business.id"),
    name: asString(value.name, "business.name"),
    slug: asNonEmptyString(value.slug, "business.slug"),
    tradeCode: asNonEmptyString(value.tradeCode, "business.tradeCode"),
  };
}

function parseJob(input: unknown): JobPropertyExportDocument["job"] {
  const value = asObject(input, "job");
  return {
    id: asNonEmptyString(value.id, "job.id"),
    status: asExactString(value.status, "COMPLETED", "job.status"),
    createdAt: asIsoDate(value.createdAt, "job.createdAt"),
    updatedAt: asIsoDate(value.updatedAt, "job.updatedAt"),
    scheduledAt: asNullableIsoDate(value.scheduledAt, "job.scheduledAt"),
    serviceIntent: asString(value.serviceIntent, "job.serviceIntent"),
    estimateId: asNullableString(value.estimateId, "job.estimateId"),
  };
}

function parseProperty(input: unknown): JobPropertyExportDocument["property"] {
  const value = asObject(input, "property");
  return {
    id: asNonEmptyString(value.id, "property.id"),
    label: asNullableString(value.label, "property.label"),
    addressLine1: asString(value.addressLine1, "property.addressLine1"),
    addressLine2: asNullableString(value.addressLine2, "property.addressLine2"),
    city: asNullableString(value.city, "property.city"),
    region: asNullableString(value.region, "property.region"),
    postalCode: asNullableString(value.postalCode, "property.postalCode"),
    createdAt: asIsoDate(value.createdAt, "property.createdAt"),
    updatedAt: asIsoDate(value.updatedAt, "property.updatedAt"),
  };
}

function parseCustomer(
  input: unknown,
  includePrivateCustomer: boolean,
): JobPropertyExportCustomer {
  const value = asObject(input, "customer");
  const included = asBoolean(value.included, "customer.included");
  if (included !== includePrivateCustomer) {
    throw invalid("customer.included must match authorization.includePrivateCustomer");
  }
  const customer: JobPropertyExportCustomer = {
    included,
    id: asNullableString(value.id, "customer.id"),
    name: asNullableString(value.name, "customer.name"),
    email: asNullableString(value.email, "customer.email"),
    phone: asNullableString(value.phone, "customer.phone"),
  };
  if (!included && (customer.name || customer.email || customer.phone)) {
    throw invalid("redacted customer contact fields must be null");
  }
  return customer;
}

function parsePhotos(input: unknown, includePhotos: boolean): JobPropertyExportDocument["photos"] {
  const value = asObject(input, "photos");
  const included = asBoolean(value.included, "photos.included");
  if (included !== includePhotos) {
    throw invalid("photos.included must match authorization.includePhotos");
  }
  const count = asNonNegativeInteger(value.count, "photos.count");
  if (!Array.isArray(value.items)) {
    throw invalid("photos.items must be an array");
  }
  if (!included && value.items.length > 0) {
    throw invalid("redacted photos.items must be empty");
  }
  const items = value.items.map((item, index) => parsePhoto(item, index, included));
  if (included && items.length !== count) {
    throw invalid("photos.count must match photos.items length when photos are included");
  }
  if (!included && count < 0) {
    throw invalid("photos.count must be a non-negative integer");
  }
  return { included, count, items };
}

function parsePhoto(input: unknown, index: number, included: boolean): JobPropertyExportPhoto {
  const value = asObject(input, `photos.items[${index}]`);
  const photo: JobPropertyExportPhoto = {
    id: asNonEmptyString(value.id, `photos.items[${index}].id`),
    stage: asNonEmptyString(value.stage, `photos.items[${index}].stage`),
    caption: asNullableString(value.caption, `photos.items[${index}].caption`),
    createdAt: asIsoDate(value.createdAt, `photos.items[${index}].createdAt`),
    marketingPermissionStatus: asNonEmptyString(
      value.marketingPermissionStatus,
      `photos.items[${index}].marketingPermissionStatus`,
    ),
    url: asNullableString(value.url, `photos.items[${index}].url`),
  };
  if (!included && photo.url) {
    throw invalid(`photos.items[${index}].url must be null when photos are redacted`);
  }
  return photo;
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
  for (const required of JOB_PROPERTY_EXPORT_OMISSIONS) {
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

function invalid(message: string): JobPropertyExportError {
  return new JobPropertyExportError("INVALID", message);
}
