import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Schedule / Jobs",
};

export default function JobsPage() {
  return (
    <PlaceholderPage
      title="Schedule / Jobs"
      description="Scheduling and job workflow are not built in Step 1. The Job model is in the database only."
    />
  );
}
