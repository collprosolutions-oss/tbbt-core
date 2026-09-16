import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { WebsiteSetupForm } from "@/components/auth/website-setup-form";
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
import { prisma } from "@/lib/prisma";
import { publicHomePath } from "@/lib/public-site";
import {
  ownerNeedsStarterServicesSetup,
  STARTER_SERVICES_SETUP_PATH,
} from "@/lib/starter-services-setup";
import {
  ownerNeedsWebsiteSetup,
  WEBSITE_SETUP_SAVED,
} from "@/lib/website-setup";
import { requireWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Website setup",
};

export default async function WebsiteSetupPage() {
  const workspace = await requireWorkspace();

  if (workspace.role !== "OWNER") {
    redirect(workspace.role === "MEMBER" ? "/field" : "/dashboard");
  }

  if (ownerNeedsFirstRunSetup(workspace)) {
    redirect(FIRST_RUN_SETUP_PATH);
  }

  if (ownerNeedsStarterServicesSetup(workspace)) {
    redirect(STARTER_SERVICES_SETUP_PATH);
  }

  const saved =
    workspace.business.websiteSetupChoice === WEBSITE_SETUP_SAVED;
  const previewHref = publicHomePath(workspace.business.slug);

  if (!ownerNeedsWebsiteSetup(workspace) && !saved) {
    redirect(postAuthenticationPath(workspace));
  }

  if (saved) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Public website ready</CardTitle>
          <CardDescription>
            Homeowners can view this business at its existing TBBT public site.
            You can change these details later in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>
              Preview the public site, then continue to the Dashboard.
            </AlertDescription>
          </Alert>
          <Link
            href={previewHref}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline", className: "w-full" })}
          >
            Preview public site
          </Link>
          <Link href="/dashboard" className={buttonVariants({ className: "w-full" })}>
            Continue to Dashboard
          </Link>
        </CardContent>
      </Card>
    );
  }

  const settings = await prisma.businessSettings.findUnique({
    where: { businessId: workspace.business.id },
    select: { approvedPublicAboutCopy: true },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up your public website</CardTitle>
        <CardDescription>
          This prepares your existing TBBT public page so it represents your
          business. You can skip and finish it later in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <WebsiteSetupForm
          businessName={workspace.business.name}
          publicPhone={workspace.business.publicPhone ?? ""}
          publicEmail={workspace.business.publicEmail ?? ""}
          approvedPublicAboutCopy={settings?.approvedPublicAboutCopy ?? ""}
          publicServiceAreaLabel={workspace.business.publicServiceAreaLabel ?? ""}
          previewHref={previewHref}
        />
      </CardContent>
    </Card>
  );
}
