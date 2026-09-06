import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  type CORSRule,
  type S3Client,
} from "@aws-sdk/client-s3";

/**
 * Narrow R2 bucket CORS for the existing browser presigned PutObject flow.
 *
 * Presigned URLs authenticate the PUT. They do not satisfy browser CORS.
 * The browser first sends OPTIONS to the R2 S3 endpoint, then PUT with
 * Content-Type and Content-Length (see R2StorageProvider.createUploadUrl).
 *
 * R2 AllowedOrigins must be exact Origin values (`scheme://host[:port]`).
 * Unique Vercel Preview hostnames change every deploy, and R2 does not
 * document a safe project-scoped wildcard. This list therefore names
 * Production CollPro origins, the stable git-branch Preview used for
 * founder testing, and the local Next port. It does not use a wildcard
 * origin or an unrestricted vercel.app pattern.
 */

export const R2_BROWSER_UPLOAD_ALLOWED_ORIGINS = [
  "https://www.collproreno.com",
  "https://collproreno.com",
  "https://collpro-reno.vercel.app",
  "https://collpro-reno-git-cursor-estimate-pri-d221ac-collpro-s-projects5.vercel.app",
  "http://localhost:43217",
  "http://127.0.0.1:43217",
] as const;

export const R2_BROWSER_UPLOAD_ALLOWED_METHODS = ["PUT"] as const;
export const R2_BROWSER_UPLOAD_ALLOWED_HEADERS = [
  "Content-Type",
  "Content-Length",
] as const;
export const R2_BROWSER_UPLOAD_EXPOSE_HEADERS = ["ETag"] as const;
export const R2_BROWSER_UPLOAD_MAX_AGE_SECONDS = 3600;

export function r2BrowserUploadCorsRules(): CORSRule[] {
  return [
    {
      AllowedOrigins: [...R2_BROWSER_UPLOAD_ALLOWED_ORIGINS],
      AllowedMethods: [...R2_BROWSER_UPLOAD_ALLOWED_METHODS],
      AllowedHeaders: [...R2_BROWSER_UPLOAD_ALLOWED_HEADERS],
      ExposeHeaders: [...R2_BROWSER_UPLOAD_EXPOSE_HEADERS],
      MaxAgeSeconds: R2_BROWSER_UPLOAD_MAX_AGE_SECONDS,
    },
  ];
}

/** Cloudflare dashboard / docs JSON shape. */
export function r2BrowserUploadCorsDashboardJson() {
  return r2BrowserUploadCorsRules();
}

export function isExactHttpOrigin(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value &&
      !value.includes("*") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function corsPolicyIsNarrow(rules: CORSRule[]) {
  if (rules.length !== 1) return false;
  const rule = rules[0];
  const origins = rule.AllowedOrigins ?? [];
  const methods = rule.AllowedMethods ?? [];
  const headers = rule.AllowedHeaders ?? [];
  return (
    origins.length > 0 &&
    origins.every((origin) => isExactHttpOrigin(origin)) &&
    methods.length === 1 &&
    methods[0] === "PUT" &&
    headers.length === 2 &&
    headers.includes("Content-Type") &&
    headers.includes("Content-Length") &&
    !origins.includes("*") &&
    !headers.includes("*") &&
    !methods.includes("*")
  );
}

function sorted(values: string[] | undefined) {
  return [...(values ?? [])].sort();
}

export function corsRulesMatch(actual: CORSRule[] | undefined, expected = r2BrowserUploadCorsRules()) {
  const left = (actual ?? []).map((rule) => ({
    AllowedOrigins: sorted(rule.AllowedOrigins),
    AllowedMethods: sorted(rule.AllowedMethods),
    AllowedHeaders: sorted(rule.AllowedHeaders),
    ExposeHeaders: sorted(rule.ExposeHeaders),
    MaxAgeSeconds: rule.MaxAgeSeconds ?? 0,
  }));
  const right = expected.map((rule) => ({
    AllowedOrigins: sorted(rule.AllowedOrigins),
    AllowedMethods: sorted(rule.AllowedMethods),
    AllowedHeaders: sorted(rule.AllowedHeaders),
    ExposeHeaders: sorted(rule.ExposeHeaders),
    MaxAgeSeconds: rule.MaxAgeSeconds ?? 0,
  }));
  return JSON.stringify(left) === JSON.stringify(right);
}

function isMissingCorsConfig(error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  const status =
    error && typeof error === "object" && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  return (
    name === "NoSuchCORSConfiguration" ||
    name === "NoSuchBucketCors" ||
    status === 404
  );
}

export type ApplyR2BrowserUploadCorsResult = {
  applied: boolean;
  reason: "already-current" | "updated";
};

export async function applyR2BrowserUploadCors(
  client: S3Client,
  bucketName: string,
): Promise<ApplyR2BrowserUploadCorsResult> {
  try {
    const current = await client.send(new GetBucketCorsCommand({ Bucket: bucketName }));
    if (corsRulesMatch(current.CORSRules)) {
      return { applied: false, reason: "already-current" };
    }
  } catch (error) {
    if (!isMissingCorsConfig(error)) throw error;
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: { CORSRules: r2BrowserUploadCorsRules() },
    }),
  );
  return { applied: true, reason: "updated" };
}

let ensurePromise: Promise<ApplyR2BrowserUploadCorsResult | void> | null = null;

const ENSURE_TIMEOUT_MS = 2500;

export function resetR2BrowserUploadCorsLatch() {
  ensurePromise = null;
}

/**
 * Apply the narrow browser-upload CORS policy once per isolate.
 * Failures and timeouts are logged and retried later so a missing
 * PutBucketCors permission cannot hang Submit Request.
 */
export function ensureR2BrowserUploadCors(client: S3Client, bucketName: string) {
  if (!ensurePromise) {
    ensurePromise = Promise.race([
      applyR2BrowserUploadCors(client, bucketName),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("R2 CORS apply timed out")), ENSURE_TIMEOUT_MS);
      }),
    ]).catch((error) => {
      ensurePromise = null;
      console.error("R2 browser-upload CORS could not be applied:", error);
    });
  }
  return ensurePromise;
}
