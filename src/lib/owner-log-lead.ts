/**
 * Owner/admin "Log lead" write path.
 *
 * Creates a real tenant-scoped ServiceRequest for phone, text, walk-in,
 * referral, or other manual inbound leads so the owner does not bypass
 * Requests / Pipeline by jumping straight to a standalone estimate.
 *
 * Customer matching reuses decideCustomerMatch() (normalized email/phone,
 * no silent merge). Lead sources stay on the existing recorded set —
 * PHONE / TEXT / WALK_IN are not schema values, so they store MANUAL and
 * keep a truthful origin note in description.
 *
 * Browser-supplied businessId is never authorization.
 * Browser-supplied tradeCode is only a requested choice and is
 * validated against this tenant's ACTIVE BusinessTrade rows.
 */
import {
  appendIntakeIdentityReview,
  decideCustomerMatch,
  normalizeEmail,
  type CustomerIdentityRecord,
} from "@/lib/customer-identity";
import {
  OWNER_DEFAULT_LEAD_SOURCE,
  parseLeadSource,
  type LeadSource,
} from "@/lib/lead-attribution";
import {
  findReusableProperty,
  hasStructuredAddressInput,
  validateStructuredAddress,
  type StructuredServiceAddress,
} from "@/lib/service-address";
import type { Prisma, PrismaClient } from "@prisma/client";
import { listActiveBusinessTrades } from "@/lib/business-trades";
import {
  resolvePublicRequestTrade,
  catalogItemTradeCode,
} from "@/lib/public-request-trade";
import { MAX_NOTES_LENGTH } from "@/lib/service-request-work";
import { isConfiguredTrade, type TradeCode } from "@/lib/trades";
import { joinRequestDescription } from "@/lib/work-area-intake";

export const OWNER_LOG_LEAD_GENERIC_ERROR = "That lead could not be logged.";

export const OWNER_LEAD_CHANNELS = [
  "PHONE",
  "TEXT",
  "WALK_IN",
  "REFERRAL",
  "MANUAL",
] as const;
export type OwnerLeadChannel = (typeof OWNER_LEAD_CHANNELS)[number];

export const OWNER_LEAD_CHANNEL_LABELS: Record<OwnerLeadChannel, string> = {
  PHONE: "Phone",
  TEXT: "Text",
  WALK_IN: "Walk-in",
  REFERRAL: "Referral",
  MANUAL: "Manual",
};

export type OwnerLogLeadAccess = {
  businessId: string;
  scope: { readonly businessId: string };
  assertOwned: <T extends { businessId: string }>(
    record: T | null | undefined,
  ) => T;
};

export type OwnerLogLeadInput = {
  /** Ignored if present. Browser-supplied businessId is never authorization. */
  businessId?: string | null;
  mode: "existing" | "new";
  customerId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  propertyChoice?: string | null;
  streetAddress?: string | null;
  unit?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  summary?: string | null;
  notes?: string | null;
  channel?: string | null;
  serviceCatalogItemId?: string | null;
  /**
   * Browser-supplied trade choice only. Never authorization.
   * Validated against this tenant's ACTIVE BusinessTrade rows
   * (or the compatibility Business.tradeCode when no ACTIVE rows exist).
   */
  tradeCode?: string | null;
  submissionId?: string | null;
};

export type OwnerLogLeadResult =
  | { ok: true; requestId: string; reused: boolean }
  | { ok: false; error: string };

export type OwnerLogLeadDb = {
  customer: {
    findFirst: (args: {
      where: { id: string; businessId: string };
      select: { id: true; businessId: true; name: true; email: true; phone: true };
    }) => Promise<{
      id: string;
      businessId: string;
      name: string;
      email: string | null;
      phone: string | null;
    } | null>;
  };
  property: {
    findFirst: (args: {
      where: { id: string; customerId: string; businessId: string };
      select: { id: true; businessId: true };
    }) => Promise<{ id: string; businessId: string } | null>;
  };
  serviceCatalogItem: {
    findFirst: (args: {
      where: { id: string; businessId: string; active: boolean };
      select: { id: true; businessId: true; name: true; tradeCode: true };
    }) => Promise<{
      id: string;
      businessId: string;
      name: string;
      tradeCode: string;
    } | null>;
  };
  business: {
    findFirst: (args: {
      where: { id: string };
      select: { tradeCode: true };
    }) => Promise<{ tradeCode: string } | null>;
  };
  businessTrade: {
    findMany: (args: {
      where: { businessId: string; status: string };
      orderBy?: Array<Record<string, "asc" | "desc">>;
    }) => Promise<
      Array<{
        id: string;
        businessId: string;
        tradeCode: string;
        status: string;
        configOverridesJson: string;
        intakeSchemaVersion: number;
        activatedAt: Date;
        deactivatedAt: Date | null;
      }>
    >;
  };
  $transaction: <T>(fn: (tx: OwnerLogLeadTx) => Promise<T>) => Promise<T>;
};

export type OwnerLogLeadTx = {
  customer: {
    findMany: (args: {
      where: { businessId: string };
      select: { id: true; name: true; email: true; phone: true };
    }) => Promise<CustomerIdentityRecord[]>;
    create: (args: {
      data: {
        businessId: string;
        name: string;
        email: string | null;
        phone: string | null;
        firstLeadSource: string | null;
      };
    }) => Promise<{ id: string; businessId: string }>;
  };
  property: {
    findMany: (args: {
      where: { businessId: string; customerId: string };
      select: {
        id: true;
        addressLine1: true;
        addressLine2: true;
        city: true;
        region: true;
        postalCode: true;
      };
    }) => Promise<
      Array<{
        id: string;
        addressLine1: string;
        addressLine2: string | null;
        city: string | null;
        region: string | null;
        postalCode: string | null;
      }>
    >;
    create: (args: {
      data: {
        businessId: string;
        customerId: string;
        addressLine1: string;
        addressLine2: string | null;
        city: string;
        region: string;
        postalCode: string | null;
      };
    }) => Promise<{ id: string }>;
  };
  serviceRequest: {
    findFirst: (args: {
      where: { businessId: string; description: { contains: string } };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: {
        businessId: string;
        customerId: string;
        propertyId: string | null;
        summary: string;
        description: string | null;
        serviceCatalogItemId: string | null;
        leadSource: string;
        originalLeadSource: string;
        tradeCode: string;
      };
    }) => Promise<{ id: string }>;
  };
  serviceRequestItem: {
    create: (args: {
      data: {
        businessId: string;
        serviceRequestId: string;
        serviceCatalogItemId: string;
        customDescription: null;
        quantity: number;
        sortOrder: number;
      };
    }) => Promise<{ id: string }>;
  };
};

export function isOwnerLeadChannel(
  value: string | null | undefined,
): value is OwnerLeadChannel {
  return Boolean(value && (OWNER_LEAD_CHANNELS as readonly string[]).includes(value));
}

export function parseOwnerLeadChannel(
  raw: string | null | undefined,
): OwnerLeadChannel {
  const value = raw?.trim().toUpperCase() ?? "";
  return isOwnerLeadChannel(value) ? value : "MANUAL";
}

/** Recorded leadSource value. PHONE / TEXT / WALK_IN are not schema values. */
export function recordedLeadSourceForChannel(channel: OwnerLeadChannel): LeadSource {
  if (channel === "REFERRAL") return "REFERRAL";
  return parseLeadSource(channel, OWNER_DEFAULT_LEAD_SOURCE) ?? OWNER_DEFAULT_LEAD_SOURCE;
}

export function leadOriginNote(channel: OwnerLeadChannel): string | null {
  if (channel === "PHONE") return "Logged lead origin: Phone";
  if (channel === "TEXT") return "Logged lead origin: Text";
  if (channel === "WALK_IN") return "Logged lead origin: Walk-in";
  return null;
}

/**
 * Trades this tenant may truthfully log a lead against.
 *
 * ACTIVE BusinessTrade rows are the authority (same membership set
 * listActiveBusinessTrades / listActiveTradeCodes read). Compatibility
 * Business.tradeCode is used only when no ACTIVE rows exist, so existing
 * Handyman-only tenants stay simple. Unlike listActiveTradeCodes, this
 * does not invent a Handyman fallback when nothing is configured.
 */
export async function authorizedOwnerLogLeadTradeCodes(
  db: OwnerLogLeadDb,
  businessId: string,
): Promise<TradeCode[]> {
  const active = await listActiveBusinessTrades(
    db as unknown as PrismaClient | Prisma.TransactionClient,
    businessId,
  );
  if (active.length > 0) return active.map((row) => row.tradeCode);
  const business = await db.business.findFirst({
    where: { id: businessId },
    select: { tradeCode: true },
  });
  const fallback = business?.tradeCode ?? "";
  return isConfiguredTrade(fallback) ? [fallback] : [];
}

function readStructuredAddress(input: OwnerLogLeadInput): StructuredServiceAddress {
  return {
    streetAddress: input.streetAddress ?? "",
    unit: input.unit ?? "",
    city: input.city ?? "",
    region: input.region ?? "",
    postalCode: input.postalCode ?? "",
  };
}

export async function createOwnerLoggedLead(
  db: OwnerLogLeadDb,
  access: OwnerLogLeadAccess,
  input: OwnerLogLeadInput,
): Promise<OwnerLogLeadResult> {
  // Browser-supplied businessId is never authorization.
  void input.businessId;
  const businessId = access.businessId;
  const mode = input.mode;
  if (mode !== "existing" && mode !== "new") {
    return { ok: false, error: "Choose an existing customer or enter a new customer." };
  }

  const name = (input.name ?? "").trim();
  const email = normalizeEmail(input.email);
  const phone = (input.phone ?? "").trim();
  const summary = (input.summary ?? "").trim();
  const notes = (input.notes ?? "").trim();
  const channel = parseOwnerLeadChannel(input.channel);
  const leadSource = recordedLeadSourceForChannel(channel);
  const propertyChoice = (input.propertyChoice ?? "none").trim() || "none";
  const catalogItemId = (input.serviceCatalogItemId ?? "").trim();
  const requestedTradeCode = (input.tradeCode ?? "").trim() || null;
  const submissionId = (input.submissionId ?? "").trim() || null;
  const structuredInput = readStructuredAddress(input);

  if (notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, error: "Please shorten the notes." };
  }

  if (email && !email.includes("@")) {
    return { ok: false, error: "Enter a valid email address." };
  }

  if (mode === "existing") {
    const selectedId = (input.customerId ?? "").trim();
    if (!selectedId) {
      return { ok: false, error: "Choose a customer." };
    }
  } else if (!name) {
    return { ok: false, error: "Customer name is required." };
  }

  if (!summary) {
    return { ok: false, error: "Enter a short scope or summary." };
  }

  let selectedCustomer: {
    id: string;
    businessId: string;
    name: string;
    email: string | null;
    phone: string | null;
  } | null = null;
  if (mode === "existing") {
    const found = await db.customer.findFirst({
      where: { id: (input.customerId ?? "").trim(), businessId },
      select: { id: true, businessId: true, name: true, email: true, phone: true },
    });
    if (!found) {
      return { ok: false, error: "That customer is not available." };
    }
    selectedCustomer = access.assertOwned(found);
  }

  let catalogItem: {
    id: string;
    businessId: string;
    name: string;
    tradeCode: string;
  } | null = null;
  if (catalogItemId) {
    const found = await db.serviceCatalogItem.findFirst({
      where: { id: catalogItemId, businessId, active: true },
      select: { id: true, businessId: true, name: true, tradeCode: true },
    });
    if (!found) {
      return { ok: false, error: "That service is not available." };
    }
    catalogItem = access.assertOwned(found);
  }

  let existingPropertyId: string | null = null;
  let newAddress: StructuredServiceAddress | null = null;
  if (propertyChoice === "none" || propertyChoice === "") {
    existingPropertyId = null;
  } else if (propertyChoice === "new") {
    if (!hasStructuredAddressInput(structuredInput)) {
      return {
        ok: false,
        error: "Enter a service address or continue without one.",
      };
    }
    const validated = validateStructuredAddress(structuredInput, { country: "US" });
    if (!validated.ok) {
      return validated;
    }
    newAddress = validated.address;
  } else {
    if (mode !== "existing" || !selectedCustomer) {
      return { ok: false, error: "That service address is not available for this customer." };
    }
    const found = await db.property.findFirst({
      where: {
        id: propertyChoice,
        customerId: selectedCustomer.id,
        businessId,
      },
      select: { id: true, businessId: true },
    });
    if (!found) {
      return { ok: false, error: "That service address is not available for this customer." };
    }
    existingPropertyId = access.assertOwned(found).id;
  }

  const origin = leadOriginNote(channel);
  const descriptionNotes = [notes, origin].filter(Boolean).join("\n\n");
  const authorizedActiveTradeCodes = await authorizedOwnerLogLeadTradeCodes(
    db,
    businessId,
  );
  const resolvedTrade = resolvePublicRequestTrade({
    catalogTradeCodes: catalogItem ? [catalogItemTradeCode(catalogItem)] : [],
    authorizedActiveTradeCodes,
    requestedTradeCode,
    includeOther: false,
  });
  if (!resolvedTrade.ok) {
    return resolvedTrade;
  }
  const tradeCode = resolvedTrade.tradeCode;

  try {
    const created = await db.$transaction(async (tx) => {
      if (submissionId) {
        const existing = await tx.serviceRequest.findFirst({
          where: {
            businessId,
            description: { contains: submissionId },
          },
          select: { id: true },
        });
        if (existing) {
          return { requestId: existing.id, reused: true };
        }
      }

      let customerId: string;
      let identityReview: Parameters<typeof appendIntakeIdentityReview>[1] | null =
        null;

      if (selectedCustomer) {
        customerId = selectedCustomer.id;
      } else {
        const existingCustomers = await tx.customer.findMany({
          where: { businessId },
          select: { id: true, name: true, email: true, phone: true },
        });
        const match = decideCustomerMatch(existingCustomers, { email, phone });
        if (match.kind === "reuse") {
          customerId = match.customer.id;
        } else {
          if (match.kind === "ambiguous") {
            identityReview = match.review;
          }
          const createdCustomer = await tx.customer.create({
            data: {
              businessId,
              name,
              email: email || null,
              phone: phone || null,
              firstLeadSource: leadSource,
            },
          });
          customerId = createdCustomer.id;
        }
      }

      let propertyId = existingPropertyId;
      if (newAddress) {
        const existingProperties = await tx.property.findMany({
          where: { businessId, customerId },
          select: {
            id: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
          },
        });
        const reusable = findReusableProperty(existingProperties, newAddress, "US");
        if (reusable) {
          propertyId = reusable.id;
        } else {
          const createdProperty = await tx.property.create({
            data: {
              businessId,
              customerId,
              addressLine1: newAddress.streetAddress,
              addressLine2: newAddress.unit || null,
              city: newAddress.city,
              region: newAddress.region,
              postalCode: newAddress.postalCode || null,
            },
          });
          propertyId = createdProperty.id;
        }
      }

      const description = identityReview
        ? appendIntakeIdentityReview(
            joinRequestDescription(descriptionNotes, null, submissionId),
            identityReview,
          )
        : joinRequestDescription(descriptionNotes, null, submissionId);

      const request = await tx.serviceRequest.create({
        data: {
          businessId,
          customerId,
          propertyId,
          summary,
          description,
          serviceCatalogItemId: catalogItem?.id ?? null,
          leadSource,
          originalLeadSource: leadSource,
          tradeCode,
        },
      });

      if (catalogItem) {
        await tx.serviceRequestItem.create({
          data: {
            businessId,
            serviceRequestId: request.id,
            serviceCatalogItemId: catalogItem.id,
            customDescription: null,
            quantity: 1,
            sortOrder: 0,
          },
        });
      }

      return { requestId: request.id, reused: false };
    });

    return { ok: true, requestId: created.requestId, reused: created.reused };
  } catch {
    return { ok: false, error: OWNER_LOG_LEAD_GENERIC_ERROR };
  }
}
