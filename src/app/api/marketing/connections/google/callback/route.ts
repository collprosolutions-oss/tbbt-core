/**
 * Google OAuth callback for one Business Profile location.
 * Public so Google can redirect without a session cookie. The hashed
 * state is the authorization. This route never publishes.
 * The browser returns only to the allowlisted Host that received the callback.
 */
import type { NextRequest } from "next/server";
import { handleMarketingConnectionCallback } from "@/lib/marketing-connections/callback-handler";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleMarketingConnectionCallback(request, "GOOGLE");
}
