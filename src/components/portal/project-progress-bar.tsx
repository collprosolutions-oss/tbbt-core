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
 *
 * Mobile keeps the existing vertical list. Desktop/tablet-wide uses a
 * horizontal stepper. The step set and current-step logic are unchanged.
 */
export function ProjectProgressBar({
  currentStep,
}: {
  currentStep: ProjectProgressStep;
}) {
  const currentIndex = PROJECT_PROGRESS_STEPS.indexOf(currentStep);

  return (
    <ol className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-0">
      {PROJECT_PROGRESS_STEPS.map((step, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;
        const isLast = index === PROJECT_PROGRESS_STEPS.length - 1;
        return (
          <li
            key={step}
            className="flex items-center gap-3 text-sm lg:min-w-0 lg:flex-1 lg:flex-col lg:items-center lg:gap-2 lg:text-center"
          >
            <span className="flex items-center lg:w-full">
              <span
                className={cn(
                  "hidden h-px min-w-3 flex-1 lg:block",
                  index === 0 && "lg:invisible",
                  index > 0 && (isDone || isCurrent)
                    ? "bg-primary"
                    : "bg-muted-foreground/25",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
                  (isDone || isCurrent) &&
                    "border-primary bg-primary text-primary-foreground",
                  !isDone &&
                    !isCurrent &&
                    "border-muted-foreground/30 text-muted-foreground",
                  isCurrent && "ring-2 ring-primary/40 ring-offset-2 ring-offset-card",
                )}
              >
                {index + 1}
              </span>
              <span
                className={cn(
                  "hidden h-px min-w-3 flex-1 lg:block",
                  isLast && "lg:invisible",
                  !isLast && isDone ? "bg-primary" : "bg-muted-foreground/25",
                )}
                aria-hidden
              />
            </span>
            <span
              className={cn(
                "lg:max-w-[9.5rem] lg:leading-snug",
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
