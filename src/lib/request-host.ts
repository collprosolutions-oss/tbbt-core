import { headers } from "next/headers";
import { firstHeaderHost } from "@/lib/vercel-app-host";

/** Current request Host, without using x-forwarded-host (Preview-unsafe). */
export async function readRequestHost(): Promise<string | null> {
  const headerList = await headers();
  return firstHeaderHost(headerList.get("host"));
}
