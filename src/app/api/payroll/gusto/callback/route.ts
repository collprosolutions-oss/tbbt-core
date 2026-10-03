/**
 * Gusto authorization-code callback. Requires the owner session that
 * minted the state. Does not call Gusto when credentials are absent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { completePayrollProviderOAuth } from "@/lib/payroll-connect/connection";
import { payrollConnectRedirectCode } from "@/lib/payroll-connect/errors";
import { navigationRedirectUrl } from "@/lib/navigation-origin";
import { prisma } from "@/lib/prisma";
import { requireOperatingBusinessAccess } from "@/lib/saas-billing/enforce";

export async function GET(request: NextRequest) {
  const originInput = {
    requestUrl: request.url,
    hostHeader: request.headers.get("host"),
    forwardedHostHeader: request.headers.get("x-forwarded-host"),
    vercelDeploymentUrl: request.headers.get("x-vercel-deployment-url"),
    vercelEnv: process.env.VERCEL_ENV,
  };
  const redirectTo = (code: string) =>
    NextResponse.redirect(navigationRedirectUrl(`/payroll?gusto=${code}#gusto-payroll`, originInput));

  const access = await requireOperatingBusinessAccess();
  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError) return redirectTo("denied");

  try {
    await completePayrollProviderOAuth(prisma, access, {
      code: request.nextUrl.searchParams.get("code") ?? "",
      state: request.nextUrl.searchParams.get("state") ?? "",
    });
    return redirectTo("connected");
  } catch (error) {
    return redirectTo(payrollConnectRedirectCode(error));
  }
}
