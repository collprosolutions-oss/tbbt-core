import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Customers",
};

export default function CustomersPage() {
  return (
    <PlaceholderPage
      title="Customers"
      description="Customer records are not managed in Step 1. The Customer and Property models are in the database only."
    />
  );
}
