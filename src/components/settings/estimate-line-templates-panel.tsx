import { ManageEstimateLineTemplates } from "@/components/estimates/estimate-line-template-forms";
import { requireManagementPageAccess } from "@/lib/access";
import {
  canAccessEstimateLineTemplates,
  TEMPLATE_FUTURE_ONLY_MESSAGE,
  TEMPLATE_UNAVAILABLE_MESSAGE,
} from "@/lib/estimate-line-templates";
import { loadEstimateLineTemplateDirectory } from "@/lib/estimate-line-template-ops";
import { prisma } from "@/lib/prisma";

export async function EstimateLineTemplatesPanel({ canManage }: { canManage: boolean }) {
  const access = await requireManagementPageAccess();
  const directory = await loadEstimateLineTemplateDirectory(prisma, access);
  const ownerCanManage = canManage && canAccessEstimateLineTemplates(access.workspace.role);

  if (!directory.available) {
    return (
      <div className="space-y-3 border-t pt-4">
        <h3 className="text-sm font-medium">Named estimate templates</h3>
        <p className="text-sm text-muted-foreground">{TEMPLATE_UNAVAILABLE_MESSAGE}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-medium">Named estimate templates</h3>
      <p className="text-sm text-muted-foreground">{TEMPLATE_FUTURE_ONLY_MESSAGE}</p>
      {!ownerCanManage ? (
        <p className="text-sm text-muted-foreground">
          Only the business owner can rename, replace, or archive saved estimate templates.
        </p>
      ) : (
        <ManageEstimateLineTemplates templates={directory.templates} />
      )}
    </div>
  );
}
