"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { isUsableEmail } from "@/lib/mail";
import { prisma } from "@/lib/prisma";

export type CustomerActionState = {
  error?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The same "reuse by email, else phone" dedup rule the existing "new
 * customer" mode on the manual Create Estimate form already uses (see
 * findReusableCustomer() in src/app/actions/estimate.ts) -- kept local to
 * this file, matching that file's own not-exported helper, rather than
 * introducing a shared cross-file customer-dedup module for one caller.
 */
async function findReusableCustomer(
  db: { customer: { findFirst: typeof prisma.customer.findFirst } },
  businessId: string,
  email: string,
  phone: string,
) {
  if (email) {
    const byEmail = await db.customer.findFirst({
      where: { businessId, email },
    });
    if (byEmail) {
      return byEmail;
    }
  }
  if (phone) {
    return db.customer.findFirst({ where: { businessId, phone } });
  }
  return null;
}

/**
 * The Customers page's own "+ New Customer" action (see
 * src/components/customers/new-customer-form.tsx). This is genuinely new:
 * until now, a Customer row could only be created as a side effect of a
 * public intake submission (src/app/actions/intake.ts) or the manual
 * Create Estimate form's "new customer" mode (src/app/actions/estimate.ts).
 * Deliberately mirrors that exact same shape (name required; phone/email/
 * address optional; same dedup-by-email-then-phone rule; address becomes a
 * real Property row) rather than inventing a different customer-creation
 * concept -- this just exposes the same real capability directly, without
 * forcing an Estimate to be created alongside it.
 */
export async function createCustomer(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);

  const name = readString(formData, "name");
  const email = readString(formData, "email").toLowerCase();
  const phone = readString(formData, "phone");
  const address = readString(formData, "address");

  if (!name) {
    return { error: "Enter a customer name." };
  }

  if (email && !isUsableEmail(email)) {
    return { error: "Enter a valid email address." };
  }

  const customer = await prisma.$transaction(async (tx) => {
    const existing = await findReusableCustomer(tx, access.businessId, email, phone);
    const record = existing
      ? access.assertOwned(existing)
      : await tx.customer.create({
          data: {
            businessId: access.businessId,
            name,
            email: email || null,
            phone: phone || null,
          },
        });

    if (address) {
      await tx.property.create({
        data: {
          businessId: access.businessId,
          customerId: record.id,
          addressLine1: address,
        },
      });
    }

    return record;
  });

  revalidatePath("/customers");
  redirect(`/customers/${customer.id}`);
}

export async function updateCustomer(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CUSTOMERS);
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
