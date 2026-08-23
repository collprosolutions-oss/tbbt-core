import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Estimates",
};

export default function EstimatesPage() {
  return (
    <PlaceholderPage
      title="Estimates"
      description="Estimate workflow is not built in Step 1. The Estimate model is in the database only."
    />
  );
}
