/**
 * Apply the narrow R2 browser-upload CORS policy using the same R2
 * credentials the app already uses for presigned PutObject.
 *
 * Safe to run on every Vercel build: the policy is idempotent and does
 * not change object/bucket public access. Missing credentials skip.
 * Apply failures log and exit 0 so Preview/Production builds continue;
 * createUploadUrl also retries the same policy before handing the
 * browser a presigned URL.
 *
 * Run with:
 *   node --experimental-strip-types scripts/apply-r2-browser-upload-cors.mjs
 */
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { S3Client } = await import("@aws-sdk/client-s3");
const { readManagedStorageConfig } = await import("@/lib/business-storage/config");
const {
  R2_BROWSER_UPLOAD_ALLOWED_ORIGINS,
  applyR2BrowserUploadCors,
  r2BrowserUploadCorsDashboardJson,
} = await import("@/lib/business-storage/r2-cors");

const config = readManagedStorageConfig();
if (!config) {
  console.log("Skipping R2 browser-upload CORS apply (R2 environment variables are not set).");
  process.exit(0);
}

const client = new S3Client({
  region: config.region,
  endpoint: config.endpoint,
  credentials: {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  },
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

try {
  const result = await applyR2BrowserUploadCors(client, config.bucketName);
  console.log(
    result.reason === "already-current"
      ? `R2 browser-upload CORS already current on ${config.bucketName}.`
      : `Applied R2 browser-upload CORS on ${config.bucketName}.`,
  );
  console.log(
    "Allowed origins:",
    R2_BROWSER_UPLOAD_ALLOWED_ORIGINS.join(", "),
  );
  console.log("Dashboard JSON:", JSON.stringify(r2BrowserUploadCorsDashboardJson(), null, 2));
} catch (error) {
  console.error("R2 browser-upload CORS apply failed; bucket public access was not changed.");
  console.error(error);
  process.exit(0);
}

const probeHosts = [
  `${config.endpoint.replace(/\/+$/, "")}/${config.bucketName}/cors-preflight-probe`,
  `https://${config.bucketName}.${config.accountId}.r2.cloudflarestorage.com/cors-preflight-probe`,
];
const sampleOrigins = [
  "https://www.collproreno.com",
  "https://collpro-reno-git-cursor-estimate-pri-d221ac-collpro-s-projects5.vercel.app",
  "http://localhost:43217",
];

for (const origin of sampleOrigins) {
  let matched = false;
  for (const probe of probeHosts) {
    try {
      const response = await fetch(probe, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type,content-length",
        },
      });
      const allowOrigin = response.headers.get("access-control-allow-origin");
      const allowMethods = response.headers.get("access-control-allow-methods") || "";
      const allowHeaders = response.headers.get("access-control-allow-headers") || "";
      if (
        allowOrigin === origin &&
        allowMethods.toUpperCase().includes("PUT") &&
        allowHeaders.toLowerCase().includes("content-type") &&
        allowHeaders.toLowerCase().includes("content-length")
      ) {
        console.log(`  ok  - OPTIONS preflight allows ${origin} via ${probe}`);
        matched = true;
        break;
      }
    } catch {
      // Try the other host style.
    }
  }
  if (!matched) {
    console.log(`  warn - OPTIONS preflight for ${origin} did not yet return CORS headers`);
  }
}

process.exit(0);
