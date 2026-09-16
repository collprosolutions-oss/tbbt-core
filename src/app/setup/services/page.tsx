import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StarterServicesSetupForm } from "@/components/auth/starter-services-setup-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  ownerNeedsFirstRunSetup,
  FIRST_RUN_SETUP_PATH,
  postAuthenticationPath,
} from "@/lib/first-run-setup";
import {
  ownerNeedsStarterServicesSetup,
  STARTER_SERVICES_SETUP_INSTALLED,
} from "@/lib/starter-services-setup";
import { requireWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Starter services",
};

export default async function StarterServicesSetupPage() {
  const workspace = await requireWorkspace();

  if (workspace.role !== "OWNER") {
    redirect(workspace.role === "MEMBER" ? "/field" : "/dashboard");
  }

  if (ownerNeedsFirstRunSetup(workspace)) {
    redirect(FIRST_RUN_SETUP_PATH);
  }

  const installed =
    workspace.business.starterServicesSetupChoice === STARTER_SERVICES_SETUP_INSTALLED;

  if (!ownerNeedsStarterServicesSetup(workspace) && !installed) {
    redirect(postAuthenticationPath(workspace));
  }

  const continueHref = postAuthenticationPath({
    ...workspace,
    business: {
      ...workspace.business,
      starterServicesSetupCompletedAt:
        workspace.business.starterServicesSetupCompletedAt ?? new Date(),
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{installed ? "Starter services added" : "Add starter services"}</CardTitle>
        <CardDescription>
          {installed
            ? "The Handyman starter services are on your list. You can edit them anytime from the Services page."
            : "TBBT can add the Handyman starter services so you do not have to create everything manually. You stay in control: add them now, or skip and create services later from the Services page."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {installed ? (
          <div className="space-y-4">
            <Alert>
              <AlertDescription>
                Handyman starter services are ready. Continue when you are.
              </AlertDescription>
            </Alert>
            <Link href={continueHref} className={buttonVariants({ className: "w-full" })}>
              Continue
            </Link>
          </div>
        ) : (
          <StarterServicesSetupForm continueHref={continueHref} />
        )}
      </CardContent>
    </Card>
  );
}
