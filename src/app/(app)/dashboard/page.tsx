import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getTrade } from "@/lib/trades";
import { requireWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const workspace = await requireWorkspace();
  const trade = getTrade(workspace.business.tradeCode);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          TBBT — The Better Business Tool
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in to {workspace.business.name}.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Handyman — Available / First Trade</CardTitle>
          <CardDescription>
            TBBT is the platform. {trade?.name ?? "Handyman"} is the first live
            trade for this workspace. Other trades are not implemented in this
            step.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Workspace</Badge>
            <span>{workspace.business.name}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Trade</Badge>
            <span>{trade?.name ?? workspace.business.tradeCode} — Available</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Role</Badge>
            <span>{workspace.role}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
