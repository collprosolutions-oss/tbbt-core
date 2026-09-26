import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LAUNCH_STEP_LABELS, type LaunchProgressSummary } from "@/lib/business-launch";

export function DashboardLaunchCard({ progress }: { progress: LaunchProgressSummary }) {
  if (!progress.hasRecordedProgress) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Help me build and understand my business</CardTitle>
          <CardDescription>
            Optional: build out more business settings. Normal TBBT operation does not require
            completing all 14 Launch steps.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button asChild size="sm" variant="outline">
            <Link href="/launch">Explore launch</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const nextLabel = progress.recommendedNext ? LAUNCH_STEP_LABELS[progress.recommendedNext] : "Review launch";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Help me build and understand my business</CardTitle>
        <CardDescription>
          {progress.completedCount} of {progress.definedStepCount} defined launch steps complete (
          {progress.progressPercent}%). This is a real checklist, not a fake score.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">Recommended next: {nextLabel}</p>
        <Button asChild size="sm">
          <Link href={progress.recommendedNext ? `/launch?step=${progress.recommendedNext}` : "/launch"}>
            Continue launch
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link href="/launch/build">Build my company</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
