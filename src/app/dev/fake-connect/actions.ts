"use server";

import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import {
  getFakePaymentProvider,
  isFakePaymentsAdapterEnabled,
} from "@/lib/payments";
import { prisma } from "@/lib/prisma";

export async function completeFakeConnectAction() {
  if (!isFakePaymentsAdapterEnabled()) {
    redirect("/settings?section=estimates-payments");
  }

  const access = await requireBusinessAccess();
  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: access.businessId },
    select: { stripeAccountId: true },
  });
  const provider = getFakePaymentProvider();
  if (account?.stripeAccountId && provider) {
    provider.setChargesEnabled(account.stripeAccountId, true);
  }
  redirect("/settings?section=estimates-payments");
}
