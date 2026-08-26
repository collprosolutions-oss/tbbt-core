"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { isUsableEmail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

export type CustomerActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function updateCustomer(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const access = await requireBusinessAccess();
  const customerId = readString(formData, "customerId");
  const name = readString(formData, "name");
  const email = readString(formData, "email");
  const phone = readString(formData, "phone");

  if (!customerId) {
    return { error: "That customer could not be updated." };
  }

  if (!name) {
    return { error: "Enter a customer name." };
  }

  if (email && !isUsableEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  const customer = access.assertOwned(
    await prisma.customer.findFirst({
      where: { id: customerId, ...access.scope },
    }),
  );

  // Update in place so every existing request, estimate, job, invoice, and
  // property relation (all keyed by this customer's id) stays intact.
  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      name,
      email: email || null,
      phone: phone || null,
    },
  });

  revalidatePath("/customers");
  revalidatePath(`/customers/${customer.id}`);
  return {};
}
