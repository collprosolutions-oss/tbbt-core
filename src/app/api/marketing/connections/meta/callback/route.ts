/**
 * Facebook Login callback for Facebook Page and Instagram connections.
 * Public so the provider can redirect without a session cookie. The
 * hashed state is the authorization. This route never publishes.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { navigationRedirectUrl } from "@/lib/navigation-origin";
import { completeMarketingConnectionCallback } from "@/lib/marketing-connections/service";

export const dynamic = "force-dynamic";

function marketingRedirect(request: NextRequest, query: string) {
  return NextResponse.redirect(
    navigationRedirectUrl(`/marketing?area=social-posts&${query}`, {
      requestUrl: request.url,
      hostHeader: request.headers.get("host"),
      forwardedHostHeader: request.headers.get("x-forwarded-host"),
      vercelDeploymentUrl: request.headers.get("x-vercel-deployment-url"),
      vercelEnv: process.env.VERCEL_ENV,
    }),
  );
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const providerError = request.nextUrl.searchParams.get("error") ?? "";
  try {
    const result = await completeMarketingConnectionCallback(prisma, {
      destinationGroup: "META",
      code,
      state,
      providerError,
    });
    if (result.kind === "needs_permission") {
      return marketingRedirect(request, "connectionError=permission");
    }
    return marketingRedirect(request, `connectionSelection=${encodeURIComponent(result.selectionToken)}`);
  } catch {
    return marketingRedirect(request, "connectionError=rejected");
  }
}
