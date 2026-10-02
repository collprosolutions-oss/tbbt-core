import type { Metadata } from "next";
import { OnceSubmitButton } from "@/components/payments/once-submit-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  STRIPE_TEST_CHECKOUT_BANNER,
  STRIPE_TEST_CHECKOUT_CANCEL_LABEL,
  STRIPE_TEST_CHECKOUT_HEADING,
  STRIPE_TEST_CHECKOUT_PAY_LABEL,
  fakeTestCheckoutAmountLabel,
  fakeTestCheckoutPurposeLabel,
  requireFakeTestCheckoutSession,
} from "@/lib/payments/test-checkout";

export const metadata: Metadata = {
  title: STRIPE_TEST_CHECKOUT_HEADING,
};

export default async function StripeTestCheckoutPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = await requireFakeTestCheckoutSession(sessionId);
  const amountLabel = fakeTestCheckoutAmountLabel(session);
  const purposeLabel = fakeTestCheckoutPurposeLabel(session.purpose);

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{STRIPE_TEST_CHECKOUT_HEADING}</CardTitle>
          <CardDescription>{STRIPE_TEST_CHECKOUT_BANNER}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            {purposeLabel} · {amountLabel}
          </p>
          <p className="text-xs text-muted-foreground">
            Session {session.id}. Returning to the project after a test pay
            records the same fake checkout the local adapter already created.
          </p>
          <form
            action={`/payments/test-checkout/${session.id}/complete`}
            method="post"
            className="space-y-3"
          >
            <OnceSubmitButton
              pendingLabel="Paying\u2026"
              className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#22c55e] px-5 text-sm font-bold text-white"
            >
              {STRIPE_TEST_CHECKOUT_PAY_LABEL}
            </OnceSubmitButton>
          </form>
          <form action={`/payments/test-checkout/${session.id}/cancel`} method="post">
            <OnceSubmitButton
              pendingLabel="Cancelling\u2026"
              className="inline-flex h-11 w-full items-center justify-center rounded-lg border px-5 text-sm font-medium"
            >
              {STRIPE_TEST_CHECKOUT_CANCEL_LABEL}
            </OnceSubmitButton>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
