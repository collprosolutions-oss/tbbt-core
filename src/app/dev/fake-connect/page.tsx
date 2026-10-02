import { notFound, redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import {
  getFakePaymentProvider,
  isFakePaymentsAdapterEnabled,
} from "@/lib/payments";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { completeFakeConnectAction } from "@/app/dev/fake-connect/actions";

export const metadata = {
  title: "Stripe test Connect",
};

export default async function FakeConnectPage() {
  if (!isFakePaymentsAdapterEnabled()) {
    notFound();
  }

  const access = await requireBusinessAccess();
  const account = await prisma.businessPaymentAccount.findUnique({
    where: { businessId: access.businessId },
    select: { stripeAccountId: true },
  });

  if (!account?.stripeAccountId) {
    redirect("/settings?section=estimates-payments");
  }

  let chargesEnabled = false;
  try {
    const readiness = await getFakePaymentProvider()?.getAccountReadiness(
      account.stripeAccountId,
    );
    chargesEnabled = readiness?.chargesEnabled === true;
  } catch {
    chargesEnabled = false;
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <form action={completeFakeConnectAction} className="w-full max-w-md space-y-4 rounded-lg border bg-white p-6">
        <h1 className="text-lg font-semibold">Stripe test Connect</h1>
        <p className="text-sm text-neutral-600">
          Local fake adapter only. Completing this page marks the connected
          account charges-enabled in test mode. No live Stripe account is
          created and no real charge can occur.
        </p>
        <p className="text-sm">
          Current charges enabled: {chargesEnabled ? "yes" : "no"}
        </p>
        <Button type="submit">Finish test-mode onboarding</Button>
      </form>
    </main>
  );
}
