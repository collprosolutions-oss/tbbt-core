import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FirstRunSetupForm } from "@/components/auth/first-run-setup-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { hasCompletedFirstRunSetup, postAuthenticationPath } from "@/lib/first-run-setup";
import { requireWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Business setup",
};

export default async function FirstRunSetupPage() {
  const workspace = await requireWorkspace();

  if (workspace.role !== "OWNER") {
    redirect(workspace.role === "MEMBER" ? "/field" : "/dashboard");
  }

  if (hasCompletedFirstRunSetup(workspace.business)) {
    redirect(postAuthenticationPath(workspace));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your business</CardTitle>
        <CardDescription>
          Add the customer-facing details homeowners will see. You can change
          these later in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FirstRunSetupForm
          businessName={workspace.business.name}
          publicPhone={workspace.business.publicPhone ?? ""}
          publicEmail={workspace.business.publicEmail ?? ""}
          publicWebsite={workspace.business.publicWebsite ?? ""}
        />
      </CardContent>
    </Card>
  );
}
