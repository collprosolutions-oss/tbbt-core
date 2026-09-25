"use server";

import { revalidatePath } from "next/cache";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import { listActiveTradeCodes } from "@/lib/business-trades";
import { proposeCompanySetupFromDescription } from "@/lib/ai/company-setup";
import { runAiTask } from "@/lib/ai/service";
import { isAiAttemptId } from "@/lib/ai/types";
import { sanitizeAiText } from "@/lib/ai/sanitize";
import {
  applyCompanySetupItem,
  companySetupErrorMessage,
  createCompanySetupProposal,
  reviewCompanySetupItem,
} from "@/lib/company-setup-ops";
import { prisma } from "@/lib/prisma";

export type CompanySetupActionState = {
  error?: string;
  message?: string;
  proposalId?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateCompany() {
  revalidatePath("/launch");
  revalidatePath("/launch/build");
  revalidatePath("/knowledge");
  revalidatePath("/services");
  revalidatePath("/business-health");
}

export async function proposeCompanySetupAction(
  _prev: CompanySetupActionState,
  formData: FormData,
): Promise<CompanySetupActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    requireBusinessCapability(access, CAPABILITIES.USE_AI_ASSIST);
    const description = readString(formData, "description");
    const attemptId = readString(formData, "attemptId");
    if (!isAiAttemptId(attemptId)) return { error: "Retry that request from the form." };
    const trades = await listActiveTradeCodes(prisma, access.businessId);
    const fallback = proposeCompanySetupFromDescription({
      description,
      activeTradeCodes: trades,
    });
    const result = await runAiTask(
      prisma,
      {
        businessId: access.businessId,
        membershipId: access.workspace.membership.id,
        userId: access.workspace.user.id,
      },
      {
        taskType: "COMPANY_SETUP",
        system:
          "Propose setup items only. Never enable a trade, change a subscription, publish a website, set a price, or create a legal commitment. Return JSON {text, stance, citedFactKeys, notes}.",
        user: JSON.stringify({ description: sanitizeAiText(description, 2_000), fallbackItems: fallback.items }),
        inputSummary: description,
        idempotencyKey: `company-setup:${access.businessId}:${attemptId}`,
        fallback: fallback.output,
        allowedFactKeys: [],
      },
    );
    const proposal = await createCompanySetupProposal(prisma, access, {
      inputText: description,
      summary: result.output?.text ?? fallback.summary,
      items: fallback.items,
      interactionId: result.interactionId,
    });
    revalidateCompany();
    return {
      message: result.message,
      proposalId: proposal.id,
    };
  } catch (error) {
    return { error: companySetupErrorMessage(error, "That company proposal could not be created.") };
  }
}

export async function reviewCompanySetupItemAction(
  _prev: CompanySetupActionState,
  formData: FormData,
): Promise<CompanySetupActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await reviewCompanySetupItem(prisma, access, {
      itemId: readString(formData, "itemId"),
      decision: readString(formData, "decision") === "REJECTED" ? "REJECTED" : "APPROVED",
    });
    revalidateCompany();
    return { message: "Proposal item reviewed. Nothing was written until you apply an approved item." };
  } catch (error) {
    return { error: companySetupErrorMessage(error, "That proposal item could not be reviewed.") };
  }
}

export async function applyCompanySetupItemAction(
  _prev: CompanySetupActionState,
  formData: FormData,
): Promise<CompanySetupActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await applyCompanySetupItem(prisma, access, readString(formData, "itemId"));
    revalidateCompany();
    return { message: "Approved item written through existing TBBT records." };
  } catch (error) {
    return { error: companySetupErrorMessage(error, "That proposal item could not be applied.") };
  }
}
