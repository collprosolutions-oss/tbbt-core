import { payInvoiceButtonLabel } from "@/lib/payments/money";
import { cn } from "@/lib/utils";

export { payInvoiceButtonLabel };

/**
 * Customer-facing checkout submit. Posts only the project token to
 * /p/[token]/pay. The amount shown here is a label; checkout reads the
 * invoice total server-side and never from this form.
 */
export function PayInvoiceButton({
  token,
  amountLabel,
  surface = "dark",
}: {
  token: string;
  amountLabel: string;
  surface?: "dark" | "light";
}) {
  return (
    <form action={`/p/${token}/pay`} method="post" className="pt-3">
      <button
        type="submit"
        className={cn(
          "inline-flex h-10 w-full items-center justify-center rounded-lg px-5 text-sm font-semibold sm:w-auto",
          surface === "dark"
            ? "bg-white text-neutral-950 hover:bg-neutral-100"
            : "bg-neutral-950 text-white hover:bg-neutral-800",
        )}
      >
        {payInvoiceButtonLabel(amountLabel)}
      </button>
    </form>
  );
}
