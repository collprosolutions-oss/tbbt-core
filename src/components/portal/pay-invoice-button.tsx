import { payInvoiceButtonLabel } from "@/lib/payments/money";

export { payInvoiceButtonLabel };

/**
 * Customer-facing checkout submit. Posts only the project token to
 * /p/[token]/pay. The amount shown here is a label; checkout reads the
 * invoice total server-side and never from this form.
 */
export function PayInvoiceButton({
  token,
  amountLabel,
}: {
  token: string;
  amountLabel: string;
}) {
  return (
    <form action={`/p/${token}/pay`} method="post" className="pt-3">
      <button
        type="submit"
        className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#22c55e] px-5 text-sm font-bold text-white shadow-[0_0_0_2px_#86efac] hover:bg-[#16a34a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#bbf7d0] focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 disabled:pointer-events-none disabled:bg-[#15803d] disabled:opacity-60 sm:w-auto"
      >
        {payInvoiceButtonLabel(amountLabel)}
      </button>
    </form>
  );
}
