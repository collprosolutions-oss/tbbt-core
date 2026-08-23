import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Services",
};

export default function ServicesPage() {
  return (
    <PlaceholderPage
      title="Services"
      description="The Handyman service catalog is not built in Step 1. The ServiceCatalogItem model is in the database only."
    />
  );
}
