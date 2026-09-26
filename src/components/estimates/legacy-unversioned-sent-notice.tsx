import { EditEstimateButton } from "@/components/estimates/edit-estimate-button";
import { LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE } from "@/lib/estimate-version";

export function LegacyUnversionedSentNotice({
  estimateId,
  showReturnAction = true,
}: {
  estimateId: string;
  showReturnAction?: boolean;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-medium">{LEGACY_SENT_WITHOUT_VERSION_OWNER_MESSAGE}</p>
      {showReturnAction ? <EditEstimateButton estimateId={estimateId} /> : null}
    </div>
  );
}
