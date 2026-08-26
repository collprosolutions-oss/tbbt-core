"use server";

import { prisma } from "@/lib/prisma";

export type IntakeResult = {
  error?: string;
  ok?: boolean;
};

const GENERIC_ERROR = "This request could not be submitted.";
export const OTHER_SERVICE_VALUE = "other";

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAddress(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function submitServiceRequest(
  slug: string,
  formData: FormData,
): Promise<IntakeResult> {
  const safeSlug = slug.trim().toLowerCase();
  if (!safeSlug) {
    return { error: GENERIC_ERROR };
  }

  const name = readString(formData, "name");
  const email = readString(formData, "email").toLowerCase();
  const phone = readString(formData, "phone");
  const address = readString(formData, "address");
  const description = readString(formData, "description");
  const serviceCatalogItemIdRaw = readString(formData, "serviceCatalogItemId");
  const serviceCatalogItemId =
    !serviceCatalogItemIdRaw || serviceCatalogItemIdRaw === OTHER_SERVICE_VALUE
      ? null
      : serviceCatalogItemIdRaw;

  if (!name || !description) {
    return { error: "Name and job description are required." };
  }

  const business = await prisma.business.findUnique({
    where: { slug: safeSlug },
    select: { id: true },
  });

  if (!business) {
    return { error: GENERIC_ERROR };
  }

  // A submitted catalog item id must be an ACTIVE item that belongs to this
  // same resolved business, so a public user can never point a tampered form
  // field at another business's (or an inactive) service.
  if (serviceCatalogItemId) {
    const catalogItem = await prisma.serviceCatalogItem.findFirst({
      where: {
        id: serviceCatalogItemId,
        businessId: business.id,
        active: true,
      },
      select: { id: true },
    });
    if (!catalogItem) {
      return { error: GENERIC_ERROR };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
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
      if (address) {
        const normalized = normalizeAddress(address);
        const existingProperties = await tx.property.findMany({
          where: { businessId: business.id, customerId: customer.id },
          select: { id: true, addressLine1: true },
        });
        const reusable = existingProperties.find(
          (property) => normalizeAddress(property.addressLine1) === normalized,
        );

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

      await tx.serviceRequest.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          propertyId,
          description,
          serviceCatalogItemId,
        },
      });
    });
  } catch {
    return { error: GENERIC_ERROR };
  }

  return { ok: true };
}
