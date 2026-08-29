"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";

export type PropertyActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function addCustomerProperty(
  _prev: PropertyActionState,
  formData: FormData,
): Promise<PropertyActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const customerId = readString(formData, "customerId");
  const label = readString(formData, "label");
  const addressLine1 = readString(formData, "addressLine1");
  const addressLine2 = readString(formData, "addressLine2");
  const city = readString(formData, "city");
  const region = readString(formData, "region");
  const postalCode = readString(formData, "postalCode");

  if (!customerId) {
    return { error: "That customer could not be found." };
  }

  if (!addressLine1) {
    return { error: "Enter a street address." };
  }

  const customer = access.assertOwned(
    await prisma.customer.findFirst({
      where: { id: customerId, ...access.scope },
    }),
  );

  // Adding a new property never touches existing properties, so historical
  // job/estimate/service-request links to older addresses stay intact.
  await prisma.property.create({
    data: {
      businessId: access.businessId,
      customerId: customer.id,
      label: label || null,
      addressLine1,
      addressLine2: addressLine2 || null,
      city: city || null,
      region: region || null,
      postalCode: postalCode || null,
    },
  });

  revalidatePath(`/customers/${customer.id}`);
  return {};
}

export async function updateCustomerProperty(
  _prev: PropertyActionState,
  formData: FormData,
): Promise<PropertyActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
  const propertyId = readString(formData, "propertyId");
  const label = readString(formData, "label");
  const addressLine1 = readString(formData, "addressLine1");
  const addressLine2 = readString(formData, "addressLine2");
  const city = readString(formData, "city");
  const region = readString(formData, "region");
  const postalCode = readString(formData, "postalCode");

  if (!propertyId) {
    return { error: "That address could not be found." };
  }

  if (!addressLine1) {
    return { error: "Enter a street address." };
  }

  const property = access.assertOwned(
    await prisma.property.findFirst({
      where: { id: propertyId, ...access.scope },
    }),
  );

  // Edit the same row in place: the id customers/estimates/jobs already
  // reference does not change, so nothing historical is replaced or lost.
  await prisma.property.update({
    where: { id: property.id },
    data: {
      label: label || null,
      addressLine1,
      addressLine2: addressLine2 || null,
      city: city || null,
      region: region || null,
      postalCode: postalCode || null,
    },
  });

  revalidatePath(`/customers/${property.customerId}`);
  return {};
}
