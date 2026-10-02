"use client";

import { useEffect, useState } from "react";
import { OnceSubmitButton } from "@/components/payments/once-submit-button";
import { payDepositButtonLabel } from "@/lib/payments/money";
import { guardPayFormSubmit, onPayFormPageShow } from "@/lib/payments/pay-form-pending";

const PAY_BUTTON_CLASS =
  "inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#22c55e] px-5 text-sm font-bold text-white shadow-[0_0_0_2px_#86efac] hover:bg-[#16a34a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#bbf7d0] focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:pointer-events-none disabled:bg-[#15803d] disabled:opacity-60";

export function PayDepositButton({
  publicToken,
  amountLabel,
  payPath,
  remaining = false,
}: {
  publicToken: string;
  amountLabel: string;
  /** Defaults to the public estimate pay route. Portal passes /p/{token}/deposit. */
  payPath?: string;
  remaining?: boolean;
}) {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      onPayFormPageShow(event, setPending);
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return (
    <form
      action={payPath ?? `/e/${publicToken}/pay`}
      method="post"
      onSubmit={(event) => {
        guardPayFormSubmit(pending, setPending, event);
      }}
    >
      <OnceSubmitButton
        pendingLabel="Opening checkout\u2026"
        className={PAY_BUTTON_CLASS}
      >
        {payDepositButtonLabel(amountLabel, remaining)}
      </OnceSubmitButton>
    </form>
  );
}
