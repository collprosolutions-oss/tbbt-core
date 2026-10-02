"use server";

import { redirect } from "next/navigation";
import {
  getFakePaymentProvider,
  isFakePaymentsAdapterEnabled,
} from "@/lib/payments";

export async function completeFakeCheckoutAction(formData: FormData) {
  if (!isFakePaymentsAdapterEnabled()) {
    redirect("/");
  }

  const sessionId =
    typeof formData.get("sessionId") === "string"
      ? String(formData.get("sessionId")).trim()
      : "";
  const token =
    typeof formData.get("token") === "string" ? String(formData.get("token")).trim() : "";

  const provider = getFakePaymentProvider();
  const session = provider?.checkouts.find((checkout) => checkout.id === sessionId);
  if (!provider || !session || !token) {
    redirect("/");
  }

  provider.completeCheckout(session.id);
  redirect(`/p/${token}?checkout=return&session_id=${encodeURIComponent(session.id)}`);
}
