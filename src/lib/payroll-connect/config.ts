/**
 * Gusto payroll-fact adapter. The fake adapter is local/script tests
 * only and cannot enable when VERCEL_ENV=production. Missing partner
 * credentials stay unavailable. An env string does not mean Connected.
 */
import { isConnectionTokenKeyConfigured } from "@/lib/connection-token-crypto";
import {
  GUSTO_DEMO_HOST,
  GUSTO_PRODUCTION_HOST,
  GUSTO_REQUIRED_ENV_NAMES,
} from "@/lib/payroll-connect/copy";

export const DISCONNECTED_PAYROLL_PROVIDER = "disconnected";
export const FAKE_PAYROLL_PROVIDER = "fake";
export const GUSTO_HTTP_PROVIDER = "gusto-http";

export type GustoEnvName = "demo" | "production";

export type GustoAvailability =
  | {
      available: false;
      missing: string[];
      fakeRefusedInProduction: boolean;
    }
  | {
      available: true;
      env: GustoEnvName;
      host: string;
      redirectUri: string;
      clientId: string;
      clientSecret: string;
    };

function trimmed(name: string) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function gustoEnvName(): GustoEnvName | null {
  const value = trimmed("GUSTO_ENV");
  if (value === "demo" || value === "production") return value;
  return null;
}

export function gustoApiHost(env: GustoEnvName) {
  return env === "production" ? GUSTO_PRODUCTION_HOST : GUSTO_DEMO_HOST;
}

export function isFakeGustoAdapterEnabled() {
  if (process.env.VERCEL_ENV === "production") return false;
  return process.env.TBBT_GUSTO_ADAPTER === "fake";
}

export function gustoFakeAdapterRefusedInProduction() {
  return process.env.VERCEL_ENV === "production" && process.env.TBBT_GUSTO_ADAPTER === "fake";
}

export function readGustoAvailability(): GustoAvailability {
  if (gustoFakeAdapterRefusedInProduction()) {
    return {
      available: false,
      missing: [...GUSTO_REQUIRED_ENV_NAMES],
      fakeRefusedInProduction: true,
    };
  }
  const missing: string[] = [];
  const clientId = trimmed("GUSTO_CLIENT_ID");
  const clientSecret = trimmed("GUSTO_CLIENT_SECRET");
  const redirectUri = trimmed("GUSTO_REDIRECT_URI");
  const env = gustoEnvName();
  if (!clientId) missing.push("GUSTO_CLIENT_ID");
  if (!clientSecret) missing.push("GUSTO_CLIENT_SECRET");
  if (!env) missing.push("GUSTO_ENV");
  if (!redirectUri) missing.push("GUSTO_REDIRECT_URI");
  if (!isConnectionTokenKeyConfigured()) missing.push("CONNECTION_TOKEN_ENCRYPTION_KEY");
  if (!env || missing.length > 0) {
    return { available: false, missing, fakeRefusedInProduction: false };
  }
  return {
    available: true,
    env,
    host: gustoApiHost(env),
    redirectUri,
    clientId,
    clientSecret,
  };
}

export function isGustoConfigured() {
  return readGustoAvailability().available;
}
