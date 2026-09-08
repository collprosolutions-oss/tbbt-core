export function PayDepositButton({
  publicToken,
  amountLabel,
}: {
  publicToken: string;
  amountLabel: string;
}) {
  return (
    <form action={`/e/${publicToken}/pay`} method="post">
      <button
        type="submit"
        className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-[#22c55e] px-5 text-sm font-bold text-white shadow-[0_0_0_2px_#86efac] hover:bg-[#16a34a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#bbf7d0] focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
      >
        Pay {amountLabel} Material Deposit
      </button>
    </form>
  );
}
