import {
  FillInBenchActiveButton,
  FillInBenchForm,
  FillInBenchUseButton,
} from "@/components/team/fill-in-bench-form";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { partitionFillInBench } from "@/lib/fill-in-bench";
import { formatBenchWorkerType, skillLabel, type FillInBenchRecord } from "@/lib/workforce";

function formatUpdatedAt(value: Date) {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function BenchWorkerCard({
  worker,
  teamMembers,
}: {
  worker: FillInBenchRecord;
  teamMembers: Array<{ membershipId: string; name: string }>;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span>{worker.displayName}</span>
          <Badge variant="secondary">{formatBenchWorkerType(worker.workerType)}</Badge>
          {worker.active ? <Badge variant="success">Active</Badge> : <Badge variant="outline">Inactive</Badge>}
          {worker.isRegularTeamMember ? (
            <Badge variant="outline">Regular team member{worker.linkedMemberName ? ` · ${worker.linkedMemberName}` : ""}</Badge>
          ) : (
            <Badge variant="outline">Bench only</Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {worker.skills.map(skillLabel).join(", ") || "No skills recorded"} · {worker.contactPreference}
          {worker.contactValue ? ` · ${worker.contactValue}` : ""}
        </p>
        {worker.availabilityNotes ? (
          <p className="text-xs text-muted-foreground">Availability: {worker.availabilityNotes}</p>
        ) : null}
        {worker.locationNotes ? (
          <p className="text-xs text-muted-foreground">Location: {worker.locationNotes}</p>
        ) : null}
        {worker.notes ? (
          <p className="text-xs text-muted-foreground">Owner notes: {worker.notes}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">Last updated {formatUpdatedAt(worker.updatedAt)}</p>
      </div>
      <FillInBenchForm worker={worker} teamMembers={teamMembers} />
      <div className="flex flex-wrap gap-2">
        <FillInBenchActiveButton benchWorkerId={worker.id} active={worker.active} />
        <FillInBenchUseButton benchWorkerId={worker.id} />
      </div>
    </div>
  );
}

export function FillInBenchWorkspace({
  bench,
  teamMembers,
  title = "Fill-In Bench",
}: {
  bench: FillInBenchRecord[];
  teamMembers: Array<{ membershipId: string; name: string }>;
  title?: string;
}) {
  const { active, inactive } = partitionFillInBench(bench);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Add a bench worker</CardTitle>
          <CardDescription>
            Record a backup worker, helper, subcontractor, or future hire for this business
            only. Saving never creates a login, assigns a job, or contacts anyone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FillInBenchForm teamMembers={teamMembers} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Available / active bench</CardTitle>
          <CardDescription>
            Active Fill-In Bench records with recorded skills and contact. This is not
            automatic assignment.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active bench workers are recorded.</p>
          ) : (
            active.map((worker) => (
              <BenchWorkerCard key={worker.id} worker={worker} teamMembers={teamMembers} />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inactive bench</CardTitle>
          <CardDescription>Deactivated records stay on file and can be reactivated.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {inactive.length === 0 ? (
            <p className="text-sm text-muted-foreground">No inactive bench workers are recorded.</p>
          ) : (
            inactive.map((worker) => (
              <BenchWorkerCard key={worker.id} worker={worker} teamMembers={teamMembers} />
            ))
          )}
        </CardContent>
      </Card>
      <p className="sr-only">{title}</p>
    </div>
  );
}
