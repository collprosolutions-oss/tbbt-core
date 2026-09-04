"use server";

import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import {
  PaymentError,
  paymentErrorMessage,
  startStripeConnectOnboarding,
} from "@/lib/payments";
import { prisma } from "@/lib/prisma";

export type PaymentSettingsActionState = {
  error?: string;
};

export async function startStripeConnect(
  _prev: PaymentSettingsActionState,
  _formData: FormData,
): Promise<PaymentSettingsActionState> {
  try {
    const access = await requireBusinessAccess();
    const result = await startStripeConnectOnboarding(prisma, access);
    redirect(result.url);
  } catch (error) {
    if (error instanceof PaymentError) {
      return { error: error.message };
    }
    if (
      error &&
      typeof error === "object" &&
      "digest" in error &&
      typeof (error as { digest?: string }).digest === "string" &&
      (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }
    return {
      error: paymentErrorMessage(
        error,
        "Stripe onboarding could not be started.",
      ),
    };
  }
}
