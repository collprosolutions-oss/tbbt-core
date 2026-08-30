"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ExportCustomerRow = {
  name: string;
  phone: string;
  email: string;
  location: string;
  jobs: number;
  totalSpentLabel: string;
  balanceLabel: string;
  lastActivityLabel: string;
};

function toCsvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * A real, minimal export of exactly the tenant-scoped rows already
 * fetched and rendered on this page (see src/app/(app)/customers/
 * page.tsx) -- no new backend endpoint, no data beyond what the owner is
 * already looking at. Respects whatever search/area filter is currently
 * applied, since it exports the rows passed in, not a separate query.
 */
export function ExportCustomersButton({ rows }: { rows: ExportCustomerRow[] }) {
  function handleExport() {
    const header = [
      "Customer",
      "Phone",
      "Email",
      "Location",
      "Jobs",
      "Total Spent",
      "Balance",
      "Last Activity",
    ];
    const lines = [
      header.join(","),
      ...rows.map((row) =>
        [
          row.name,
          row.phone,
          row.email,
          row.location,
          row.jobs,
          row.totalSpentLabel,
          row.balanceLabel,
          row.lastActivityLabel,
        ]
          .map(toCsvCell)
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Button type="button" size="sm" variant="outline" onClick={handleExport} disabled={rows.length === 0}>
      <Download className="size-4" />
      Export
    </Button>
  );
}
