import type { Metadata } from "next";
import { LaborMinimumSettingsForm } from "@/components/settings/labor-minimum-settings-form";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireBusinessAccess } from "@/lib/access";

export const metadata: Metadata = {
  title: "Business Settings",
};

export default async function SettingsPage() {
  const access = await requireBusinessAccess();
  const business = access.workspace.business;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Business Settings"
        description={business.name}
      />

      <Card>
        <CardHeader>
          <CardTitle>Labor Minimum Service Fee</CardTitle>
          <CardDescription>
            Sets the minimum labor charge for a service visit. If labor on an
            estimate is below this amount, TBBT adds only the difference. The
            owner may waive the minimum on an individual estimate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LaborMinimumSettingsForm
            enabled={business.laborMinimumEnabled}
            amount={business.laborMinimumAmount?.toString() ?? ""}
          />
        </CardContent>
      </Card>
    </div>
  );
}
