import { notFound } from "next/navigation";
import {
  getFakePaymentProvider,
  isFakePaymentsAdapterEnabled,
} from "@/lib/payments";
import { completeFakeCheckoutAction } from "@/app/dev/fake-checkout/actions";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Stripe test checkout",
};

export default async function FakeCheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; token?: string }>;
}) {
  if (!isFakePaymentsAdapterEnabled()) {
    notFound();
  }

  const query = await searchParams;
  const sessionId = query.session_id?.trim() ?? "";
  const token = query.token?.trim() ?? "";
  const provider = getFakePaymentProvider();
  const session = provider?.checkouts.find((checkout) => checkout.id === sessionId);

  if (!session || !token) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <p className="text-sm text-neutral-600">This test checkout is not available.</p>
      </main>
    );
  }

  const amountLabel = `$${(session.amountCents / 100).toFixed(2)}`;

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <form action={completeFakeCheckoutAction} className="w-full max-w-md space-y-4 rounded-lg border bg-white p-6">
        <input type="hidden" name="sessionId" value={session.id} />
        <input type="hidden" name="token" value={token} />
        <h1 className="text-lg font-semibold">Stripe test checkout</h1>
        <p className="text-sm text-neutral-600">
          Local fake adapter only. No real card is charged and no customer
          message is sent. Completing this page records a test payment of{" "}
          {amountLabel}.
        </p>
        <p className="text-sm font-medium">Amount due: {amountLabel}</p>
        <Button type="submit">Pay with test card</Button>
      </form>
    </main>
  );
}
