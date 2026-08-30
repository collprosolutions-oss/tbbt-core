"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PAYMENT_METHODS } from "@/lib/invoice-payment";

/**
 * Real filter on Invoice.paymentMethod -- the exact same 5 values
 * MarkInvoicePaidForm already writes (see src/lib/invoice-payment.ts).
 * Only PAID invoices ever have a payment method set, so this naturally
 * (and correctly) only ever matches paid invoices -- no fabricated
 * options.
 */
export function PaymentMethodFilterSelect({ value }: { value: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <select
      aria-label="Filter by payment method"
      value={value}
      onChange={(event) => {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("page");
        if (event.target.value === "all") {
          params.delete("method");
        } else {
          params.set("method", event.target.value);
        }
        const query = params.toString();
        router.push(`/invoices${query ? `?${query}` : ""}`);
      }}
      className="h-9 w-full min-w-40 rounded-lg border border-input bg-transparent px-3 text-sm sm:w-auto"
    >
      <option value="all">All Payment Methods</option>
      {PAYMENT_METHODS.map((method) => (
        <option key={method.value} value={method.value}>
          {method.label}
        </option>
      ))}
    </select>
  );
}
