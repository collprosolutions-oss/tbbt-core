import { redirect } from "next/navigation";
import { requireBusinessAccess } from "@/lib/access";
import { startStripeConnectOnboarding } from "@/lib/payments";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const access = await requireBusinessAccess();
    const result = await startStripeConnectOnboarding(prisma, access);
    redirect(result.url);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "digest" in error &&
      typeof (error as { digest?: string }).digest === "string" &&
      (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw error;
    }
    redirect("/settings?section=estimates-payments");
  }
}
