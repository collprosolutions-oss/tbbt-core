export function PayInvoiceButton({ token }: { token: string }) {
  return (
    <form action={`/p/${token}/pay`} method="post" className="pt-3">
      <button
        type="submit"
        className="inline-flex h-9 items-center justify-center rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white"
      >
        Pay Invoice
      </button>
    </form>
  );
}
