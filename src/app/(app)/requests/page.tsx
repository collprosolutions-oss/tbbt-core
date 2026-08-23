import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Requests",
};

export default function RequestsPage() {
  return (
    <PlaceholderPage
      title="Requests"
      description="Service request intake is not built in Step 1. The ServiceRequest model is in the database only."
    />
  );
}
