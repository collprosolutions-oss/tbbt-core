"use client";

import { useActionState } from "react";
import { updatePipelineStageAction, type PipelineActionState } from "@/app/actions/pipeline";
import { Button } from "@/components/ui/button";
import {
  PIPELINE_LOSS_REASON_LABELS,
  PIPELINE_LOSS_REASONS,
  PIPELINE_STAGE_LABELS,
  allowedOwnerStages,
  canClearOwnerStage,
  type PipelineOwnerStage,
  type PipelineStage,
} from "@/lib/pipeline";

const initial: PipelineActionState = {};

export function PipelineStageForm({
  opportunityKey,
  stage,
  estimateStatus,
  hasJob,
  lossReason,
  lossReasonNote,
}: {
  opportunityKey: string;
  stage: PipelineStage;
  estimateStatus: string | null;
  hasJob: boolean;
  lossReason: string | null;
  lossReasonNote: string | null;
}) {
  const [state, formAction, pending] = useActionState(updatePipelineStageAction, initial);
  const facts = { ownerStage: null, estimateStatus, hasJob };
  const allowed = allowedOwnerStages(facts);
  const canClear = canClearOwnerStage(facts);

  if (allowed.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {PIPELINE_STAGE_LABELS[stage]} comes from the approved estimate or job and cannot be changed by hand.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {allowed.map((ownerStage) => (
          <form action={formAction} key={ownerStage}>
            <input type="hidden" name="opportunityKey" value={opportunityKey} />
            <input type="hidden" name="ownerStage" value={ownerStage} />
            <Button
              type="submit"
              size="sm"
              variant={stage === ownerStage ? "default" : "outline"}
              disabled={pending || stage === ownerStage}
            >
              {PIPELINE_STAGE_LABELS[ownerStage as PipelineOwnerStage]}
            </Button>
          </form>
        ))}
        {canClear && stage !== "NEW_LEAD" && stage !== "ESTIMATE_IN_PROGRESS" && stage !== "ESTIMATE_SENT" ? (
          <form action={formAction}>
            <input type="hidden" name="opportunityKey" value={opportunityKey} />
            <input type="hidden" name="ownerStage" value="" />
            <Button type="submit" size="sm" variant="ghost" disabled={pending}>
              Clear owner stage
            </Button>
          </form>
        ) : null}
      </div>

      {allowed.includes("LOST") ? (
        <form action={formAction} className="space-y-2 rounded-md border border-border/70 p-3">
          <input type="hidden" name="opportunityKey" value={opportunityKey} />
          <input type="hidden" name="ownerStage" value="LOST" />
          <p className="text-xs font-medium">Mark lost</p>
          <label className="block text-xs text-muted-foreground">
            Loss reason (optional)
            <select
              name="lossReason"
              defaultValue={lossReason ?? ""}
              className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
            >
              <option value="">No reason recorded</option>
              {PIPELINE_LOSS_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {PIPELINE_LOSS_REASON_LABELS[reason]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-muted-foreground">
            Internal note (optional)
            <input
              name="lossReasonNote"
              defaultValue={lossReasonNote ?? ""}
              className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <Button type="submit" size="sm" variant="destructive" disabled={pending}>
            {pending ? "Saving…" : "Mark lost"}
          </Button>
        </form>
      ) : null}

      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </div>
  );
}
