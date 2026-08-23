import type { Metadata } from "next";
import { PlaceholderPage } from "@/components/placeholder-page";

export const metadata: Metadata = {
  title: "Business Settings",
};

export default function SettingsPage() {
  return (
    <PlaceholderPage
      title="Business Settings"
      description="Business settings screens are not built in Step 1. Workspace name, trade, and membership already exist on the Business and Membership models."
    />
  );
}
