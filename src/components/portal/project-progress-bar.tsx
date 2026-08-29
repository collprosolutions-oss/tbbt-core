import {
  PROJECT_PROGRESS_LABELS,
  PROJECT_PROGRESS_STEPS,
  type ProjectProgressStep,
} from "@/lib/project-progress";
import { cn } from "@/lib/utils";

/**
 * Renders the locked 5-step project progress structure, highlighting
 * whichever step `currentStep` resolves to. See resolveProjectProgressStep()
 * in src/lib/project-progress.ts for how that step is derived from real
 * Job/Invoice status -- this component only renders, it never decides.
 */
export function ProjectProgressBar({
  currentStep,
}: {
  currentStep: ProjectProgressStep;
}) {
  const currentIndex = PROJECT_PROGRESS_STEPS.indexOf(currentStep);

  return (
    <ol className="space-y-3">
      {PROJECT_PROGRESS_STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <li key={step} className="flex items-center gap-3 text-sm">
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
                (isDone || isCurrent) &&
                  "border-primary bg-primary text-primary-foreground",
                !isDone &&
                  !isCurrent &&
                  "border-muted-foreground/30 text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span
              className={cn(
                !isDone && !isCurrent && "text-muted-foreground",
                isCurrent && "font-medium",
              )}
            >
              {PROJECT_PROGRESS_LABELS[step]}
              {isCurrent ? " (Current)" : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
