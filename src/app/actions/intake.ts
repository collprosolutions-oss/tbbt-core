"use server";

import { prisma } from "@/lib/prisma";

export type IntakeResult = {
  error?: string;
  ok?: boolean;
};

const GENERIC_ERROR = "This request could not be submitted.";

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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

      const property = address
        ? await tx.property.create({
            data: {
              businessId: business.id,
              customerId: customer.id,
              addressLine1: address,
            },
          })
        : null;

      await tx.serviceRequest.create({
        data: {
          businessId: business.id,
          customerId: customer.id,
          propertyId: property?.id,
          description,
        },
      });
    });
  } catch {
    return { error: GENERIC_ERROR };
  }

  return { ok: true };
}
