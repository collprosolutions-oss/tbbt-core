"use server";

/**
 * Owner payroll-provider actions. Tenant scope comes from the session.
 * Returns only safe messages. Tokens stay on the server.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  disconnectPayrollProvider,
  importProcessedPayrollFacts,
  payrollConnectPublicMessage,
  refreshPayrollConnection,
  reviewPayrollProviderFact,
  startPayrollProviderConnect,
} from "@/lib/payroll-connect";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";

export type PayrollConnectActionState = {
  error?: string;
  message?: string;
};

function revalidatePayrollConnect() {
  revalidatePath("/payroll");
  revalidatePath("/integrations");
  revalidatePath("/settings");
}

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function startPayrollProviderConnectAction(
  _prev: PayrollConnectActionState,
  _formData: FormData,
): Promise<PayrollConnectActionState> {
  let authorizeUrl = "";
  try {
    const access = await requireOperatingBusinessAccess();
    const started = await startPayrollProviderConnect(prisma, access);
    authorizeUrl = started.authorizeUrl;
  } catch (error) {
    return { error: payrollConnectPublicMessage(error) };
  }
  redirect(authorizeUrl);
}

export async function refreshPayrollProviderAction(
  _prev: PayrollConnectActionState,
  _formData: FormData,
): Promise<PayrollConnectActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const result = await refreshPayrollConnection(prisma, access);
    revalidatePayrollConnect();
    return {
      message: result.rotated
        ? "Gusto issued a new token pair. The previous refresh token is no longer valid."
        : "The saved Gusto access token is still valid.",
    };
  } catch (error) {
    return { error: payrollConnectPublicMessage(error) };
  }
}

export async function importPayrollProviderFactsAction(
  _prev: PayrollConnectActionState,
  _formData: FormData,
): Promise<PayrollConnectActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const result = await importProcessedPayrollFacts(prisma, access);
    revalidatePayrollConnect();
    return {
      message: `Imported ${result.imported} processed payroll fact(s) for review. They are not verified bank movement.`,
    };
  } catch (error) {
    return { error: payrollConnectPublicMessage(error) };
  }
}

export async function disconnectPayrollProviderAction(
  _prev: PayrollConnectActionState,
  _formData: FormData,
): Promise<PayrollConnectActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    await disconnectPayrollProvider(prisma, access);
    revalidatePayrollConnect();
    return {
      message:
        "Encrypted tokens were removed. Imported facts remain. Gusto was not revoked remotely.",
    };
  } catch (error) {
    return { error: payrollConnectPublicMessage(error) };
  }
}

export async function reviewPayrollProviderFactAction(
  _prev: PayrollConnectActionState,
  formData: FormData,
): Promise<PayrollConnectActionState> {
  try {
    const access = await requireOperatingBusinessAccess();
    const reviewStatus = readString(formData, "reviewStatus");
    if (reviewStatus !== "ACCEPTED" && reviewStatus !== "IGNORED") {
      return { error: "Choose accept or ignore." };
    }
    await reviewPayrollProviderFact(prisma, access, {
      factId: readString(formData, "factId"),
      reviewStatus,
    });
    revalidatePayrollConnect();
    return {
      message:
        reviewStatus === "ACCEPTED"
          ? "Fact marked accepted. No payroll run or bank row was changed."
          : "Fact marked ignored. No payroll run or bank row was changed.",
    };
  } catch (error) {
    return { error: payrollConnectPublicMessage(error) };
  }
}
