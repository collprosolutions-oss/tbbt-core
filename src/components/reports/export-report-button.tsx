"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

function toCsvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Client-side CSV of rows already assembled on the server for the
 * current report area -- the same pattern as ExportCustomersButton.
 */
export function ExportReportButton({
  filename,
  headers,
  rows,
}: {
  filename: string;
  headers: string[];
  rows: string[][];
}) {
  function handleExport() {
    const lines = [headers.map(toCsvCell).join(","), ...rows.map((row) => row.map(toCsvCell).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Button type="button" size="sm" variant="outline" onClick={handleExport} disabled={rows.length === 0}>
      <Download className="size-4" />
      Export CSV
    </Button>
  );
}
