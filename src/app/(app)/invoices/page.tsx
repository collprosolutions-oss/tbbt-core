import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Invoices",
};

export default function InvoicesPage() {
  return (
    <PlaceholderPage
      title="Invoices"
      description="Invoice and payment workflow are not built in Step 1. The Invoice model is in the database only."
    />
  );
}
