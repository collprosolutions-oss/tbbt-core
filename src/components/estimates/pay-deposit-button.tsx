import { payDepositButtonLabel } from "@/lib/payments/money";

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
  return (
    <form action={payPath ?? `/e/${publicToken}/pay`} method="post">
      <button
        type="submit"
        className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#22c55e] px-5 text-sm font-bold text-white shadow-[0_0_0_2px_#86efac] hover:bg-[#16a34a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#bbf7d0] focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
      >
        {payDepositButtonLabel(amountLabel, remaining)}
      </button>
    </form>
  );
}
