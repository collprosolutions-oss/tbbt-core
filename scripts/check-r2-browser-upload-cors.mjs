/**
 * Narrow R2 browser-upload CORS policy + existing presigned PUT path.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-r2-browser-upload-cors.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const {
  R2_BROWSER_UPLOAD_ALLOWED_HEADERS,
  R2_BROWSER_UPLOAD_ALLOWED_METHODS,
  R2_BROWSER_UPLOAD_ALLOWED_ORIGINS,
  R2_BROWSER_UPLOAD_EXPOSE_HEADERS,
  corsPolicyIsNarrow,
  corsRulesMatch,
  isExactHttpOrigin,
  r2BrowserUploadCorsDashboardJson,
  r2BrowserUploadCorsRules,
} = await import("@/lib/business-storage/r2-cors");

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const rules = r2BrowserUploadCorsRules();
const origins = [...R2_BROWSER_UPLOAD_ALLOWED_ORIGINS];
const requestFlow = readRepo("src/components/public/request-flow.tsx");
const r2Provider = readRepo("src/lib/business-storage/r2-provider.ts");
const publicPhotos = readRepo("src/app/actions/public-request-photos.ts");
const applyScript = readRepo("scripts/apply-r2-browser-upload-cors.mjs");
const packageJson = readRepo("package.json");
const dashboardFile = JSON.parse(readRepo("src/lib/business-storage/r2-browser-upload-cors.json"));

console.log("\nUNIT — Exact origins, PUT-only methods, signed headers");
check(
  "Every allowed origin is an exact scheme://host[:port] value",
  origins.length >= 5 && origins.every((origin) => isExactHttpOrigin(origin)),
);
check(
  "Policy includes Production CollPro origins",
  origins.includes("https://www.collproreno.com") &&
    origins.includes("https://collproreno.com") &&
    origins.includes("https://collpro-reno.vercel.app"),
);
check(
  "Policy includes the stable collpro-reno git-branch Preview origin",
  origins.includes(
    "https://collpro-reno-git-cursor-estimate-pri-d221ac-collpro-s-projects5.vercel.app",
  ),
);
check(
  "Policy includes localhost development on the app port",
  origins.includes("http://localhost:43217") &&
    origins.includes("http://127.0.0.1:43217"),
);
check(
  "No wildcard origins, methods, or headers",
  !origins.some((origin) => origin.includes("*")) &&
    !R2_BROWSER_UPLOAD_ALLOWED_METHODS.includes("*") &&
    !R2_BROWSER_UPLOAD_ALLOWED_HEADERS.includes("*") &&
    !JSON.stringify(origins).includes("*") &&
    !JSON.stringify([...R2_BROWSER_UPLOAD_ALLOWED_HEADERS]).includes("*"),
);
check(
  "Only PUT is allowed — matching the existing presigned upload method",
  R2_BROWSER_UPLOAD_ALLOWED_METHODS.length === 1 &&
    R2_BROWSER_UPLOAD_ALLOWED_METHODS[0] === "PUT",
);
check(
  "Allowed headers are only Content-Type and Content-Length",
  R2_BROWSER_UPLOAD_ALLOWED_HEADERS.length === 2 &&
    R2_BROWSER_UPLOAD_ALLOWED_HEADERS.includes("Content-Type") &&
    R2_BROWSER_UPLOAD_ALLOWED_HEADERS.includes("Content-Length"),
);
check(
  "ETag is exposed for the official PutObject CORS example",
  R2_BROWSER_UPLOAD_EXPOSE_HEADERS.includes("ETag"),
);
check("Dashboard JSON matches the S3 CORS rule", corsRulesMatch(r2BrowserUploadCorsDashboardJson(), rules));
check(
  "Committed Cloudflare dashboard file matches the TypeScript policy",
  corsRulesMatch(dashboardFile, rules),
);
check("Policy helper reports the rule as narrow", corsPolicyIsNarrow(rules) === true);
check(
  "A wildcard policy is rejected by the narrowness check",
  corsPolicyIsNarrow([
    {
      AllowedOrigins: ["*"],
      AllowedMethods: ["PUT"],
      AllowedHeaders: ["Content-Type", "Content-Length"],
    },
  ]) === false,
);
check(
  "Unique per-commit Preview hashes are not allowlisted",
  !origins.some((origin) => /collpro-reno-[a-z0-9]{8,}-collpro-s-projects5\.vercel\.app/i.test(origin)),
);

console.log("\nSTATIC — Existing presigned PUT path is unchanged");
check(
  "Browser still PUTs to the authorized R2 URL with the signed headers",
  requestFlow.includes("authorizePublicRequestPhotoUpload") &&
    requestFlow.includes("authorized.uploadUrl") &&
    requestFlow.includes('method: authorized.uploadMethod || "PUT"') &&
    requestFlow.includes("headers: authorized.uploadHeaders") &&
    requestFlow.includes("body: photo.file"),
);
check(
  "Failed photo PUT still aborts and returns before submitServiceRequest",
  requestFlow.includes("if (!uploaded.ok)") &&
    requestFlow.indexOf("if (!uploaded.ok)") <
      requestFlow.lastIndexOf("submitPublicIntakeForm") &&
    requestFlow.includes("abortPublicRequestPhotoUpload") &&
    requestFlow.includes("setError") &&
    requestFlow.includes("finally") &&
    requestFlow.includes("setPending(false)") &&
    requestFlow.includes("submissionId"),
);
check(
  "Presigner still uses PutObject with ContentType and ContentLength",
  r2Provider.includes("PutObjectCommand") &&
    r2Provider.includes("ContentType: input.contentType") &&
    r2Provider.includes("ContentLength: input.contentLength") &&
    r2Provider.includes('"Content-Type": input.contentType') &&
    r2Provider.includes('"Content-Length": String(input.contentLength)') &&
    r2Provider.includes("ensureR2BrowserUploadCors"),
);
check(
  "Public photo authorize still returns the R2 upload URL, not a proxy",
  publicPhotos.includes("uploadUrl: authorized.upload.url") &&
    publicPhotos.includes('uploadMethod: authorized.upload.method') &&
    !publicPhotos.includes("/api/storage/public/"),
);
check(
  "Build applies the same CORS policy with existing R2 credentials",
  applyScript.includes("applyR2BrowserUploadCors") &&
    applyScript.includes("readManagedStorageConfig") &&
    packageJson.includes("apply-r2-browser-upload-cors.mjs"),
);

if (failed) {
  console.error(`\n${failed} check(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`\n${passed} checks passed.`);
