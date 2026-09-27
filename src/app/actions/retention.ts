"use server";

import { revalidatePath } from "next/cache";
import { PRODUCT_CAPABILITIES } from "@/lib/product-catalog/codes";
import { requireProductCapability } from "@/lib/product-entitlements";
import { prisma } from "@/lib/prisma";
import {
  RETENTION_FOLLOW_UP_RECORDED_MESSAGE,
  RETENTION_FOLLOW_UP_UPDATED_MESSAGE,
  RETENTION_ROUTE,
  recordRetentionFollowUpTask,
  retentionFollowUpErrorMessage,
} from "@/lib/growth/retention";
import { requireOperatingProductAccess } from "@/lib/saas-billing/enforce";

export type RetentionFollowUpActionState = { error?: string; message?: string };

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function recordRetentionFollowUpTaskAction(
  _prev: RetentionFollowUpActionState,
  formData: FormData,
): Promise<RetentionFollowUpActionState> {
  try {
    const access = await requireOperatingProductAccess(PRODUCT_CAPABILITIES.MARKETING_TOOLS);
    await requireProductCapability(prisma, access.businessId, PRODUCT_CAPABILITIES.REPORTING_INSIGHTS);
    const result = await recordRetentionFollowUpTask(prisma, access, {
      customerId: readString(formData, "customerId"),
      jobId: readString(formData, "jobId"),
      group: readString(formData, "group"),
    });
    revalidatePath(RETENTION_ROUTE);
    return {
      message:
        result.outcome === "CREATED"
          ? RETENTION_FOLLOW_UP_RECORDED_MESSAGE
          : RETENTION_FOLLOW_UP_UPDATED_MESSAGE,
    };
  } catch (error) {
    return { error: retentionFollowUpErrorMessage(error, "That follow-up task could not be recorded.") };
  }
}
