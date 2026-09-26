/**
 * Record journey navigation.
 *
 * Builds compact related-record links from actual foreign keys only.
 * Never infers a link from a similar name, similar amount, or a shared
 * customer. If a relationship is missing, it is omitted.
 *
 * Tenant scope is applied at every hop. The origin uses `access.scope`.
 * Nested to-many relations add `where: { businessId }`. Nested to-one
 * relations are used only when `related.businessId === access.businessId`.
 * A foreign-key match alone is never the tenant boundary.
 *
 * Authorization is applied when items are built: MEMBER never receives
 * management financial hrefs, and estimate/invoice links require the
 * matching capability.
 */
import type { MembershipRole } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  CAPABILITIES,
  canAccessManagementConsole,
  roleHasCapability,
} from "@/lib/authorization";
import { formatAddress } from "@/lib/format";
import {
  recordNavInvoiceLabel,
  sortInvoicesOldestFirst,
} from "@/lib/revenue-integrity";

export const RECORD_NAV_KINDS = [
  "customer",
  "property",
  "request",
  "estimate",
  "job",
  "invoice",
] as const;

export type RecordNavKind = (typeof RECORD_NAV_KINDS)[number];

export type RecordNavOriginKind = Exclude<RecordNavKind, "property">;

export type RecordNavOrigin = {
  kind: RecordNavOriginKind;
  id: string;
};

export type RecordNavItem = {
  kind: RecordNavKind;
  id: string;
  href: string | null;
  label: string;
  current: boolean;
};

export type RecordNavRelated = {
  customer?: { id: string; name?: string | null } | null;
  property?: {
    id: string;
    customerId?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
  } | null;
  requests?: readonly { id: string }[] | null;
  estimates?: readonly { id: string }[] | null;
  jobs?: readonly { id: string }[] | null;
  invoices?: readonly { id: string; kind?: string | null; createdAt?: Date }[] | null;
};

export type RecordNavAccess = {
  businessId: string;
  scope: { readonly businessId: string };
  workspace: { role: MembershipRole };
};

const JOURNEY_ORDER: readonly RecordNavKind[] = [
  "customer",
  "property",
  "request",
  "estimate",
  "job",
  "invoice",
];

export function recordHref(kind: RecordNavKind, id: string, customerId?: string | null): string | null {
  switch (kind) {
    case "customer":
      return `/customers/${id}`;
    case "request":
      return `/requests/${id}`;
    case "estimate":
      return `/estimates/${id}`;
    case "job":
      return `/jobs/${id}`;
    case "invoice":
      return `/invoices/${id}`;
    case "property":
      return customerId ? `/customers/${customerId}#service-addresses` : null;
    default:
      return null;
  }
}

/**
 * MEMBER is redirected off the management console and must never receive
 * a financial record href from this helper. Estimate and invoice links
 * also require their existing management capabilities.
 */
export function recordNavKindAllowed(
  role: MembershipRole,
  kind: RecordNavKind,
): boolean {
  if (!canAccessManagementConsole(role)) return false;
  if (kind === "estimate") {
    return roleHasCapability(role, CAPABILITIES.MANAGE_ESTIMATES);
  }
  if (kind === "invoice") {
    return roleHasCapability(role, CAPABILITIES.MANAGE_INVOICES);
  }
  return true;
}

function uniqueById<T extends { id: string }>(rows: readonly T[] | null | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows ?? []) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function itemLabel(
  kind: RecordNavKind,
  related: RecordNavRelated,
  row: { id: string; kind?: string | null },
): string {
  if (kind === "invoice") return recordNavInvoiceLabel(row.kind);
  if (kind === "customer") return related.customer?.name?.trim() || "Customer";
  if (kind === "property") {
    const property = related.property;
    if (property?.addressLine1) {
      return formatAddress({
        addressLine1: property.addressLine1,
        addressLine2: property.addressLine2,
        city: property.city,
        region: property.region,
        postalCode: property.postalCode,
      });
    }
    return "Property";
  }
  if (kind === "request") return "Request";
  if (kind === "estimate") return "Estimate";
  if (kind === "job") return "Job";
  return "Record";
}

export function buildRecordNavItems(input: {
  origin: RecordNavOrigin;
  related: RecordNavRelated;
  role: MembershipRole;
}): RecordNavItem[] {
  const { origin, related, role } = input;
  if (!canAccessManagementConsole(role)) return [];

  const invoices = sortInvoicesOldestFirst(
    uniqueById(related.invoices ?? []).map((invoice) => ({
      ...invoice,
      createdAt: invoice.createdAt ?? new Date(0),
    })),
  );

  const groups: Record<RecordNavKind, { id: string; kind?: string | null }[]> = {
    customer: related.customer ? [{ id: related.customer.id }] : [],
    property: related.property ? [{ id: related.property.id }] : [],
    request: uniqueById(related.requests),
    estimate: uniqueById(related.estimates),
    job: uniqueById(related.jobs),
    invoice: invoices,
  };

  const items: RecordNavItem[] = [];
  for (const kind of JOURNEY_ORDER) {
    if (!recordNavKindAllowed(role, kind)) continue;
    for (const row of groups[kind]) {
      const current = origin.kind === kind && origin.id === row.id;
      const customerId =
        kind === "property"
          ? related.property?.customerId ?? related.customer?.id ?? null
          : related.customer?.id ?? null;
      items.push({
        kind,
        id: row.id,
        href: current ? null : recordHref(kind, row.id, customerId),
        label: itemLabel(kind, related, row),
        current,
      });
    }
  }
  return items;
}

function emptyRelated(): RecordNavRelated {
  return {};
}

function ownedByBusiness<T extends { businessId: string }>(
  row: T | null | undefined,
  businessId: string,
): T | null {
  return row && row.businessId === businessId ? row : null;
}

function projectProperty(
  property:
    | {
        id: string;
        businessId: string;
        customerId?: string | null;
        addressLine1?: string | null;
        addressLine2?: string | null;
        city?: string | null;
        region?: string | null;
        postalCode?: string | null;
      }
    | null
    | undefined,
  businessId: string,
  ownedCustomerId?: string | null,
) {
  const owned = ownedByBusiness(property, businessId);
  if (!owned) return null;
  return {
    id: owned.id,
    customerId: ownedCustomerId ?? null,
    addressLine1: owned.addressLine1,
    addressLine2: owned.addressLine2,
    city: owned.city,
    region: owned.region,
    postalCode: owned.postalCode,
  };
}

export async function loadRecordJourney(
  db: PrismaClient,
  access: RecordNavAccess,
  origin: RecordNavOrigin,
): Promise<RecordNavItem[]> {
  const related = await loadRecordNavRelated(db, access, origin);
  if (!related) return [];
  return buildRecordNavItems({
    origin,
    related,
    role: access.workspace.role,
  });
}

async function loadRecordNavRelated(
  db: PrismaClient,
  access: RecordNavAccess,
  origin: RecordNavOrigin,
): Promise<RecordNavRelated | null> {
  const tenantWhere = { businessId: access.businessId };
  const propertySelect = {
    id: true,
    businessId: true,
    customerId: true,
    addressLine1: true,
    addressLine2: true,
    city: true,
    region: true,
    postalCode: true,
  } as const;
  const customerSelect = { id: true, businessId: true, name: true } as const;
  const invoiceSelect = {
    id: true,
    kind: true,
    createdAt: true,
  } as const;

  switch (origin.kind) {
    case "customer": {
      const customer = await db.customer.findFirst({
        where: { id: origin.id, ...access.scope },
        select: {
          id: true,
          name: true,
          serviceRequests: {
            where: tenantWhere,
            select: { id: true },
            orderBy: { createdAt: "asc" },
          },
          estimates: {
            where: tenantWhere,
            select: { id: true },
            orderBy: { createdAt: "asc" },
          },
          jobs: {
            where: tenantWhere,
            select: { id: true },
            orderBy: { createdAt: "asc" },
          },
          invoices: {
            where: tenantWhere,
            select: invoiceSelect,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      });
      if (!customer) return null;
      return {
        customer: { id: customer.id, name: customer.name },
        requests: customer.serviceRequests,
        estimates: customer.estimates,
        jobs: customer.jobs,
        invoices: customer.invoices,
      };
    }
    case "request": {
      const request = await db.serviceRequest.findFirst({
        where: { id: origin.id, ...access.scope },
        select: {
          id: true,
          customer: { select: customerSelect },
          property: { select: propertySelect },
          estimates: {
            where: tenantWhere,
            select: { id: true },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!request) return null;
      const customer = ownedByBusiness(request.customer, access.businessId);
      return {
        customer: customer ? { id: customer.id, name: customer.name } : null,
        property: projectProperty(request.property, access.businessId, customer?.id),
        requests: [{ id: request.id }],
        estimates: request.estimates,
      };
    }
    case "estimate": {
      const estimate = await db.estimate.findFirst({
        where: { id: origin.id, ...access.scope },
        select: {
          id: true,
          customer: { select: customerSelect },
          property: { select: propertySelect },
          serviceRequest: { select: { id: true, businessId: true } },
          jobs: {
            where: tenantWhere,
            select: {
              id: true,
              invoices: {
                where: tenantWhere,
                select: invoiceSelect,
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!estimate) return null;
      const customer = ownedByBusiness(estimate.customer, access.businessId);
      const request = ownedByBusiness(estimate.serviceRequest, access.businessId);
      return {
        customer: customer ? { id: customer.id, name: customer.name } : null,
        property: projectProperty(estimate.property, access.businessId, customer?.id),
        requests: request ? [{ id: request.id }] : [],
        estimates: [{ id: estimate.id }],
        jobs: estimate.jobs,
        invoices: estimate.jobs.flatMap((job) => job.invoices),
      };
    }
    case "job": {
      const job = await db.job.findFirst({
        where: { id: origin.id, ...access.scope },
        select: {
          id: true,
          customer: { select: customerSelect },
          property: { select: propertySelect },
          estimate: {
            select: {
              id: true,
              businessId: true,
              serviceRequest: { select: { id: true, businessId: true } },
            },
          },
          invoices: {
            where: tenantWhere,
            select: invoiceSelect,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      });
      if (!job) return null;
      const customer = ownedByBusiness(job.customer, access.businessId);
      const estimate = ownedByBusiness(job.estimate, access.businessId);
      const request = ownedByBusiness(estimate?.serviceRequest, access.businessId);
      return {
        customer: customer ? { id: customer.id, name: customer.name } : null,
        property: projectProperty(job.property, access.businessId, customer?.id),
        requests: request ? [{ id: request.id }] : [],
        estimates: estimate ? [{ id: estimate.id }] : [],
        jobs: [{ id: job.id }],
        invoices: job.invoices,
      };
    }
    case "invoice": {
      const invoice = await db.invoice.findFirst({
        where: { id: origin.id, ...access.scope },
        select: {
          id: true,
          kind: true,
          createdAt: true,
          customer: { select: customerSelect },
          job: {
            select: {
              id: true,
              businessId: true,
              estimate: { select: { id: true, businessId: true } },
            },
          },
        },
      });
      if (!invoice) return null;
      const customer = ownedByBusiness(invoice.customer, access.businessId);
      const job = ownedByBusiness(invoice.job, access.businessId);
      const estimate = ownedByBusiness(job?.estimate, access.businessId);
      return {
        customer: customer ? { id: customer.id, name: customer.name } : null,
        estimates: estimate ? [{ id: estimate.id }] : [],
        jobs: job ? [{ id: job.id }] : [],
        invoices: [invoice],
      };
    }
    default:
      return emptyRelated();
  }
}
