import { resolveBusinessServiceArea } from "@/lib/business-service-area";
import { OTHER_SERVICE_VALUE } from "@/lib/intake";
import {
  findReusableLegacyProperty,
  findReusableProperty,
  hasStructuredAddressInput,
  validateStructuredAddress,
  type StructuredServiceAddress,
} from "@/lib/service-address";
import {
  MAX_INTAKE_PHOTOS,
  MAX_NOTES_LENGTH,
  parseSelectedTasks,
  requestedWorkLabels,
  requestedWorkSummary,
  type SelectedPublicTask,
} from "@/lib/service-request-work";

export const PUBLIC_INTAKE_GENERIC_ERROR = "This request could not be submitted.";

export type PublicIntakeInput = {
  slug: string;
  /** Ignored if present. Browser-supplied businessId is never authorization. */
  businessId?: string | null;
  name: string;
  email: string;
  phone: string;
  address: string;
  streetAddress?: string;
  unit?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  notes: string;
  catalogItemIds: string[];
  catalogQuantities?: Record<string, unknown>;
  includeOther: boolean;
  otherDescription: string;
  otherQuantity?: unknown;
  photoUrls?: string[];
};

export type PublicIntakeDb = {
  business: {
    findUnique: (args: {
      where: { slug: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  serviceCatalogItem: {
    findMany: (args: {
      where: { id: { in: string[] }; businessId: string; active: boolean };
      select: { id: true; name: true };
    }) => Promise<Array<{ id: string; name: string }>>;
  };
  $transaction: <T>(fn: (tx: PublicIntakeTx) => Promise<T>) => Promise<T>;
};

export type PublicIntakeTx = {
  customer: {
    findFirst: (args: {
      where: { businessId: string; email?: string; phone?: string };
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: {
        businessId: string;
        name: string;
        email: string | null;
        phone: string | null;
      };
    }) => Promise<{ id: string }>;
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
        addressLine2?: string | null;
        city?: string | null;
        region?: string | null;
        postalCode?: string | null;
      };
    }) => Promise<{ id: string }>;
  };
  serviceRequest: {
    create: (args: {
      data: {
        businessId: string;
        customerId: string;
        propertyId: string | null;
        description: string | null;
        summary: string | null;
        serviceCatalogItemId: string | null;
      };
    }) => Promise<{ id: string }>;
  };
  serviceRequestItem: {
    createMany: (args: {
      data: Array<{
        businessId: string;
        serviceRequestId: string;
        serviceCatalogItemId: string | null;
        customDescription: string | null;
        quantity: number;
        sortOrder: number;
      }>;
    }) => Promise<unknown>;
  };
  serviceRequestPhoto: {
    createMany: (args: {
      data: Array<{
        businessId: string;
        serviceRequestId: string;
        url: string;
      }>;
    }) => Promise<unknown>;
  };
};

export type PublicIntakeResult =
  | { ok: true; requestId: string }
  | { ok: false; error: string };

export function readIntakeCatalogIds(rawIds: string[]) {
  return rawIds
    .map((value) => value.trim())
    .filter((value) => value && value !== OTHER_SERVICE_VALUE);
}

export async function createPublicServiceRequest(
  db: PublicIntakeDb,
  input: PublicIntakeInput,
): Promise<PublicIntakeResult> {
  const safeSlug = input.slug.trim().toLowerCase();
  if (!safeSlug) {
    return { ok: false, error: PUBLIC_INTAKE_GENERIC_ERROR };
  }

  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim();
  const address = input.address.trim();
  const structuredInput: StructuredServiceAddress = {
    streetAddress: input.streetAddress ?? "",
    unit: input.unit ?? "",
    city: input.city ?? "",
    region: input.region ?? "",
    postalCode: input.postalCode ?? "",
  };
  const notes = input.notes.trim();
  const serviceArea = resolveBusinessServiceArea({ slug: safeSlug });
  const usingStructured = hasStructuredAddressInput(structuredInput);
  const structured = usingStructured
    ? validateStructuredAddress(structuredInput, { country: serviceArea.country })
    : null;
  if (structured && !structured.ok) {
    return structured;
  }

  if (!name) {
    return { ok: false, error: "Name is required." };
  }
  if (notes.length > MAX_NOTES_LENGTH) {
    return { ok: false, error: "Please shorten the project notes." };
  }

  const parsed = parseSelectedTasks({
    catalogItemIds: readIntakeCatalogIds(input.catalogItemIds),
    catalogQuantities: input.catalogQuantities,
    includeOther: input.includeOther,
    otherDescription: input.otherDescription,
    otherQuantity: input.otherQuantity,
  });
  if (!parsed.ok) {
    return parsed;
  }

  const business = await db.business.findUnique({
    where: { slug: safeSlug },
    select: { id: true },
  });
  if (!business) {
    return { ok: false, error: PUBLIC_INTAKE_GENERIC_ERROR };
  }

  const catalogIds = parsed.tasks
    .filter((task): task is Extract<SelectedPublicTask, { kind: "catalog" }> => task.kind === "catalog")
    .map((task) => task.serviceCatalogItemId);

  let catalogById = new Map<string, { id: string; name: string }>();
  if (catalogIds.length > 0) {
    const catalogItems = await db.serviceCatalogItem.findMany({
      where: {
        id: { in: catalogIds },
        businessId: business.id,
        active: true,
      },
      select: { id: true, name: true },
    });
    if (catalogItems.length !== catalogIds.length) {
      return { ok: false, error: PUBLIC_INTAKE_GENERIC_ERROR };
    }
    catalogById = new Map(catalogItems.map((item) => [item.id, item]));
  }

  const labels = requestedWorkLabels({
    items: parsed.tasks.map((task) =>
      task.kind === "catalog"
        ? { serviceCatalogItem: catalogById.get(task.serviceCatalogItemId) ?? null }
        : { customDescription: task.customDescription },
    ),
  });
  const firstCatalogId =
    parsed.tasks.find((task) => task.kind === "catalog")?.serviceCatalogItemId ??
    null;
  const summary = requestedWorkSummary(labels, 120);
  const description = notes || null;
  const photoUrls = (input.photoUrls ?? []).filter(Boolean).slice(0, MAX_INTAKE_PHOTOS);

  try {
    const requestId = await db.$transaction(async (tx) => {
      let customer =
        email
          ? await tx.customer.findFirst({
              where: { businessId: business.id, email },
            })
          : null;

      if (!customer && phone) {
        customer = await tx.customer.findFirst({
          where: { businessId: business.id, phone },
        });
      }

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            businessId: business.id,
            name,
            email: email || null,
            phone: phone || null,
          },
        });
      }

      let propertyId: string | null = null;
      if (structured?.ok) {
        const existingProperties = await tx.property.findMany({
          where: { businessId: business.id, customerId: customer.id },
          select: {
            id: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
          },
        });
        const reusable = findReusableProperty(
          existingProperties,
          structured.address,
          serviceArea.country,
        );
        if (reusable) {
          propertyId = reusable.id;
        } else {
          const property = await tx.property.create({
            data: {
              businessId: business.id,
              customerId: customer.id,
              addressLine1: structured.address.streetAddress,
              addressLine2: structured.address.unit || null,
              city: structured.address.city,
              region: structured.address.region,
              postalCode: structured.address.postalCode || null,
            },
          });
          propertyId = property.id;
        }
      } else if (address) {
        const existingProperties = await tx.property.findMany({
          where: { businessId: business.id, customerId: customer.id },
          select: {
            id: true,
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
          },
        });
        const reusable = findReusableLegacyProperty(existingProperties, address);
        if (reusable) {
          propertyId = reusable.id;
        } else {
          const property = await tx.property.create({
            data: {
              businessId: business.id,
              customerId: customer.id,
              addressLine1: address,
            },
          });
          propertyId = property.id;
        }
      }

      const request = await tx.serviceRequest.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          propertyId,
          description,
          summary,
          serviceCatalogItemId: firstCatalogId,
        },
      });

      await tx.serviceRequestItem.createMany({
        data: parsed.tasks.map((task, index) =>
          task.kind === "catalog"
            ? {
                businessId: business.id,
                serviceRequestId: request.id,
                serviceCatalogItemId: task.serviceCatalogItemId,
                customDescription: null,
                quantity: task.quantity,
                sortOrder: index,
              }
            : {
                businessId: business.id,
                serviceRequestId: request.id,
                serviceCatalogItemId: null,
                customDescription: task.customDescription,
                quantity: task.quantity,
                sortOrder: index,
              },
        ),
      });

      if (photoUrls.length > 0) {
        await tx.serviceRequestPhoto.createMany({
          data: photoUrls.map((url) => ({
            businessId: business.id,
            serviceRequestId: request.id,
            url,
          })),
        });
      }

      return request.id;
    });

    return { ok: true, requestId };
  } catch {
    return { ok: false, error: PUBLIC_INTAKE_GENERIC_ERROR };
  }
}
