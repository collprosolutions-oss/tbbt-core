/**
 * Public Meta and Google callbacks. The return origin is the allowlisted
 * Host only. Forwarded headers, preview URLs, and request.url are ignored.
 * A rejected host does not consume OAuth state and does not redirect.
 */
import type { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { completeMarketingConnectionCallback } from "@/lib/marketing-connections/service";
import {
  MARKETING_CONNECTION_HOST_REJECTED_MESSAGE,
  marketingConnectionCallbackUrl,
  marketingConnectionProductionOrigin,
} from "@/lib/marketing-connections/return-origin";

let callbackDbForTests: PrismaClient | null = null;

/** Route tests share the disposable database. Production never replaces Prisma. */
export function useMarketingConnectionCallbackDbForTests(db: PrismaClient | null) {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
    throw new Error("Refusing to replace the marketing callback database.");
  }
  callbackDbForTests = db;
}

function callbackDatabase() {
  if (
    callbackDbForTests &&
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production"
  ) {
    return callbackDbForTests;
  }
  return prisma;
}

function finishOnOrigin(origin: string, query: string) {
  return NextResponse.redirect(new URL(`/marketing?area=social-posts&${query}`, origin));
}

export async function handleMarketingConnectionCallback(
  request: NextRequest,
  group: "META" | "GOOGLE",
) {
  const origin = marketingConnectionProductionOrigin(request.headers.get("host"));
  const redirectUri = marketingConnectionCallbackUrl(group, origin);
  if (!origin || !redirectUri) {
    return new NextResponse(MARKETING_CONNECTION_HOST_REJECTED_MESSAGE, { status: 400 });
  }
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const providerError = request.nextUrl.searchParams.get("error") ?? "";
  try {
    const result = await completeMarketingConnectionCallback(callbackDatabase(), {
      destinationGroup: group,
      code,
      state,
      providerError,
      redirectUri,
    });
    if (result.kind === "needs_permission") {
      return finishOnOrigin(origin, "connectionError=permission");
    }
    return finishOnOrigin(origin, `connectionSelection=${encodeURIComponent(result.selectionToken)}`);
  } catch {
    return finishOnOrigin(origin, "connectionError=rejected");
  }
}
