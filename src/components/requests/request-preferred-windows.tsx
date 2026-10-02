import type { OwnerPreferredWindowsView } from "@/lib/request-preferred-windows";

export function RequestPreferredWindowsList({
  preferredWindows,
  onUse,
}: {
  preferredWindows: OwnerPreferredWindowsView;
  onUse?: (window: OwnerPreferredWindowsView["windows"][number]) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3 text-sm">
      <p className="font-medium">Customer preferred days or times</p>
      <p className="text-xs text-muted-foreground">{preferredWindows.notABooking}</p>
      <ul className="space-y-2">
        {preferredWindows.windows.map((window) => (
          <li key={window.id} className="space-y-1">
            <p className={window.status === "expired" ? "text-muted-foreground" : ""}>
              {window.label}
            </p>
            {onUse && window.status === "current" ? (
              <button
                type="button"
                className="text-sm font-medium underline underline-offset-4"
                onClick={() => onUse(window)}
              >
                {window.kind === "WINDOW" ? "Use this window" : "Use this day"}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Times are shown in {preferredWindows.timeZone}. Using a preference only
        fills the schedule form — it does not book the visit.
      </p>
    </div>
  );
}
