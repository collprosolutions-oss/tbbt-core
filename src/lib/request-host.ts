import { headers } from "next/headers";
import {
  firstHeaderHost,
  firstHeaderHostWithPort,
} from "@/lib/vercel-app-host";

/** Current request Host, without using x-forwarded-host (Preview-unsafe). */
export async function readRequestHost(): Promise<string | null> {
  const headerList = await headers();
  return firstHeaderHost(headerList.get("host"));
}

/** Origin from the browser Host header. Keeps localhost ports. Never uses x-forwarded-host. */
export function originFromRequestHost(
  host: string | null | undefined,
): string | undefined {
  const hostWithPort = firstHeaderHostWithPort(host);
  if (!hostWithPort) return undefined;
  const hostname = firstHeaderHost(hostWithPort);
  if (!hostname) return undefined;
  const protocol = hostname === "localhost" || hostname === "127.0.0.1" ? "http" : "https";
  return `${protocol}://${hostWithPort}`;
}

export async function readRequestOrigin(): Promise<string | undefined> {
  const headerList = await headers();
  return originFromRequestHost(headerList.get("host"));
}
