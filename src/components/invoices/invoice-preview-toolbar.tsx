"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export function InvoicePreviewToolbar({
  backHref,
  backLabel,
  pdfHref,
}: {
  backHref: string;
  backLabel: string;
  pdfHref: string;
}) {
  return (
    <div className="invoice-preview-toolbar flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-3 print:hidden">
      <Button asChild size="sm" variant="outline">
        <Link href={backHref}>{backLabel}</Link>
      </Button>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={pdfHref}>Download PDF</a>
        </Button>
        <Button size="sm" type="button" onClick={() => window.print()}>
          Print PDF
        </Button>
      </div>
    </div>
  );
}
