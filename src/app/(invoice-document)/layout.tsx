import type { ReactNode } from "react";

export default function InvoiceDocumentLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="min-h-full bg-neutral-100 text-neutral-900 print:bg-white">
      <style>{`@media print { @page { margin: 0.6in; } body { background: white; } }`}</style>
      {children}
    </div>
  );
}
