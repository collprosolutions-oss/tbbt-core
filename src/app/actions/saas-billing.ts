"use server";

import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { ForbiddenError } from "@/lib/authorization";
import { prisma } from "@/lib/prisma";
import {
  requestSaasPlanChange,
  SaasBillingError,
  saasBillingErrorMessage,
  startSaasBillingPortal,
  startSaasSubscriptionCheckout,
} from "@/lib/saas-billing";

export type SaasBillingActionState = {
  error?: string;
};

function rethrowRedirect(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "digest" in error &&
    typeof (error as { digest?: string }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  ) {
    throw error;
  }
}

export async function startSaasSubscriptionCheckoutAction(
  _prev: SaasBillingActionState,
  formData: FormData,
): Promise<SaasBillingActionState> {
  try {
    const access = await requireBusinessAccess();
    const requested = formData.get("planCode");
    const planCode = typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
    const result = await startSaasSubscriptionCheckout(prisma, access, { planCode });
    redirect(result.url);
  } catch (error) {
    rethrowRedirect(error);
    if (error instanceof ForbiddenError) {
      return { error: error.message };
    }
    return {
      error: saasBillingErrorMessage(
        error,
        "TBBT subscription checkout could not be started.",
      ),
    };
  }
}

export async function startSaasBillingPortalAction(
  _prev: SaasBillingActionState,
  _formData: FormData,
): Promise<SaasBillingActionState> {
  try {
    const access = await requireBusinessAccess();
    const result = await startSaasBillingPortal(prisma, access);
    redirect(result.url);
  } catch (error) {
    rethrowRedirect(error);
    if (error instanceof ForbiddenError) {
      return { error: error.message };
    }
    if (error instanceof SaasBillingError) {
      return { error: error.message };
    }
    return {
      error: saasBillingErrorMessage(
        error,
        "Stripe Billing Portal is not available on this Stripe account yet.",
      ),
    };
  }
}

export async function requestSaasPlanChangeAction(
  _prev: SaasBillingActionState,
  formData: FormData,
): Promise<SaasBillingActionState> {
  try {
    const access = await requireBusinessAccess();
    const requested = formData.get("planCode");
    const planCode = typeof requested === "string" ? requested.trim() : "";
    await requestSaasPlanChange(prisma, access, { planCode });
    return { error: undefined };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return { error: error.message };
    }
    return {
      error: saasBillingErrorMessage(
        error,
        "That TBBT plan change could not be requested.",
      ),
    };
  }
}
