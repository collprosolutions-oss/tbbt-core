import Link from "next/link";
import { ActionCenterConfirmForm } from "@/components/actions/action-center-confirm-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  ActionCenterLiveTarget,
  ActionCenterRecordedResult,
  ControlledActionCenter,
} from "@/lib/chief-of-staff/action-center";

function TargetLink({
  href,
  label,
}: {
  href: string | null;
  label: string;
}) {
  if (!href) {
    return <span>{label}</span>;
  }
  return (
    <Link className="text-primary underline-offset-4 hover:underline" href={href}>
      {label}
    </Link>
  );
}

function LiveTargetCard({
  row,
  canConfirm,
}: {
  row: ActionCenterLiveTarget;
  canConfirm: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="font-medium">{row.targetLabel}</p>
      <p className="text-sm text-muted-foreground">
        Target: recommendation · <TargetLink href={row.targetHref} label={row.targetEntityId} />
      </p>
      {row.why ? <p className="mt-1 text-sm">Why: {row.why}</p> : null}
      {row.recordedStatus ? (
        <p className="text-xs text-muted-foreground">Recorded recommendation status: {row.recordedStatus}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No persisted proposal. Live catalog item — owner confirmation required.
        </p>
      )}
      {row.relatedAreaHref ? (
        <p className="mt-1 text-sm">
          <Link className="text-primary underline-offset-4 hover:underline" href={row.relatedAreaHref}>
            Related records
          </Link>
        </p>
      ) : null}
      <ul className="mt-3 space-y-3">
        {row.availableActions.map((action) => (
          <li key={action.actionKey} className="space-y-2">
            <div>
              <p className="text-sm font-medium">{action.displayLabel}</p>
              <p className="text-xs text-muted-foreground">{action.purpose}</p>
              <p className="text-xs text-muted-foreground">Approval: {action.approvalClass}</p>
            </div>
            {canConfirm ? (
              <ActionCenterConfirmForm
                actionKey={action.actionKey}
                targetEntityId={row.targetEntityId}
                displayLabel={action.displayLabel}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                Only the business owner can confirm a Controlled AI Action.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordedResultCard({ row }: { row: ActionCenterRecordedResult }) {
  return (
    <div className="rounded-md border p-3">
      <p className="font-medium">{row.displayLabel}</p>
      <p className="text-sm text-muted-foreground">{row.purpose}</p>
      <p className="mt-1 text-sm">
        Target: recommendation · <TargetLink href={row.targetHref} label={row.targetLabel} />
      </p>
      {row.why ? <p className="mt-1 text-sm">Why: {row.why}</p> : null}
      <p className="mt-1 text-sm">Recorded status: {row.recordedStatus}</p>
      <p className="text-xs text-muted-foreground">Updated {row.recordedAtLabel}</p>
      {row.actionItemStatus ? (
        <p className="text-xs text-muted-foreground">Action-plan item: {row.actionItemStatus}</p>
      ) : null}
      {row.relatedAreaHref ? (
        <p className="mt-1 text-sm">
          <Link className="text-primary underline-offset-4 hover:underline" href={row.relatedAreaHref}>
            Related records
          </Link>
        </p>
      ) : null}
      {row.history.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {row.history.map((entry) => (
            <li key={`${entry.at}-${entry.status}`}>
              {entry.atLabel} — {entry.status}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No additional persisted attempt history. V1 stores the current recorded result.
        </p>
      )}
    </div>
  );
}

export function ActionCenterBoard({
  center,
  canConfirm,
  showCatalog = true,
}: {
  center: Pick<ControlledActionCenter, "needsOwnerConfirmation" | "recordedResults"> &
    Partial<Pick<ControlledActionCenter, "catalog">>;
  canConfirm: boolean;
  showCatalog?: boolean;
}) {
  return (
    <div className="space-y-4">
      {showCatalog && center.catalog ? (
      <Card>
        <CardHeader>
          <CardTitle>Allowed Controlled AI Actions</CardTitle>
          <CardDescription>
            This center does not add action types. Every V1 action stays owner-confirmed and
            delegates to an existing domain operation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {center.catalog.map((row) => (
            <div key={row.actionKey}>
              <p className="font-medium">{row.displayLabel}</p>
              <p className="text-muted-foreground">{row.purpose}</p>
              <p className="text-xs text-muted-foreground">
                {row.actionKey} · {row.approvalClass}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
      ) : null}

      {showCatalog || center.needsOwnerConfirmation.length > 0 ? (
      <Card>
        <CardHeader>
          <CardTitle>Owner confirmation required</CardTitle>
          <CardDescription>
            Live catalog recommendations that still accept a V1 action. Preparing a proposal
            does not record a queue item. Confirm and execute are the same owner step.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {center.needsOwnerConfirmation.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No live recommendations currently accept a Controlled AI Action.
            </p>
          ) : (
            center.needsOwnerConfirmation.map((row) => (
              <LiveTargetCard key={row.id} row={row} canConfirm={canConfirm} />
            ))
          )}
        </CardContent>
      </Card>
      ) : null}

      {showCatalog || center.recordedResults.length > 0 ? (
      <Card>
        <CardHeader>
          <CardTitle>Recorded results</CardTitle>
          <CardDescription>
            Existing recommendation states and owner action-plan items. Failed confirmations
            are not persisted as attempts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {center.recordedResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recorded Controlled AI Action results yet.</p>
          ) : (
            center.recordedResults.map((row) => <RecordedResultCard key={`${row.actionKey}-${row.id}`} row={row} />)
          )}
        </CardContent>
      </Card>
      ) : null}
    </div>
  );
}
