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
        className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-emerald-700 px-5 text-sm font-semibold text-white hover:bg-emerald-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
      >
        {payInvoiceButtonLabel(amountLabel)}
      </button>
    </form>
  );
}
