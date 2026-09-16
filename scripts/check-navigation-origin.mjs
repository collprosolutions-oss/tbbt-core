/**
 * Focused check for Preview-safe auth redirect origins.
 *
 * On Vercel Preview, request.url / x-forwarded-host can be the production
 * domain. Auth redirects must stay on the current *.vercel.app host.
 * Production collproreno.com must keep using the request origin.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-navigation-origin.mjs
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { navigationOrigin, navigationRedirectUrl } = await import(
  "@/lib/navigation-origin"
);

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const previewHost = "collpro-reno-git-branch-team.vercel.app";
const previewRequest = {
  requestUrl: "https://collproreno.com/settings?section=data-export",
  hostHeader: previewHost,
  forwardedHostHeader: "collproreno.com",
  vercelDeploymentUrl: previewHost,
  vercelEnv: "preview",
};

console.log("\nSTATIC — navigationOrigin on Preview vs production");

check(
  "Preview Host wins over production request.url / x-forwarded-host",
  navigationOrigin(previewRequest) === `https://${previewHost}`,
);
check(
  "Preview sign-in redirect stays on the current vercel.app host",
  navigationRedirectUrl("/sign-in", previewRequest).href ===
    `https://${previewHost}/sign-in`,
);
check(
  "Preview signed-in /sign-in bounce stays on the current vercel.app host",
  navigationRedirectUrl("/dashboard", previewRequest).href ===
    `https://${previewHost}/dashboard`,
);
check(
  "x-vercel-deployment-url is used when Host is the production domain",
  navigationOrigin({
    requestUrl: "https://collproreno.com/settings?section=data-export",
    hostHeader: "collproreno.com",
    forwardedHostHeader: "www.collproreno.com",
    vercelDeploymentUrl: previewHost,
    vercelEnv: "preview",
  }) === `https://${previewHost}`,
);
check(
  "trusted x-forwarded-host is used when Host is absent",
  navigationOrigin({
    requestUrl: "https://collproreno.com/dashboard",
    hostHeader: null,
    forwardedHostHeader: previewHost,
    vercelDeploymentUrl: null,
    vercelEnv: "preview",
  }) === `https://${previewHost}`,
);
check(
  "production collproreno.com is unchanged even when a vercel.app deployment URL is present",
  navigationOrigin({
    requestUrl: "https://collproreno.com/settings?section=data-export",
    hostHeader: "collproreno.com",
    forwardedHostHeader: "collproreno.com",
    vercelDeploymentUrl: "collpro-reno-abc123.vercel.app",
    vercelEnv: "production",
  }) === "https://collproreno.com",
);
check(
  "production www.collproreno.com is unchanged",
  navigationOrigin({
    requestUrl: "https://www.collproreno.com/sign-in",
    hostHeader: "www.collproreno.com",
    forwardedHostHeader: "www.collproreno.com",
    vercelEnv: "production",
  }) === "https://www.collproreno.com",
);
check(
  "local / missing VERCEL_ENV keeps request.url origin",
  navigationOrigin({
    requestUrl: "http://127.0.0.1:43217/field",
    hostHeader: "127.0.0.1:43217",
    vercelEnv: null,
  }) === "http://127.0.0.1:43217",
);
check(
  "non-vercel.app Host on Preview is not trusted",
  navigationOrigin({
    requestUrl: "https://collproreno.com/settings",
    hostHeader: "evil.example.com",
    forwardedHostHeader: "evil.example.com",
    vercelEnv: "preview",
  }) === "https://collproreno.com",
);
check(
  "URL-shaped or userinfo hosts are rejected",
  navigationOrigin({
    requestUrl: "https://collproreno.com/settings",
    hostHeader: "https://evil.vercel.app",
    vercelDeploymentUrl: "user@evil.vercel.app",
    vercelEnv: "preview",
  }) === "https://collproreno.com",
);

const originSrc = readRepo("src/lib/navigation-origin.ts");
const proxySrc = readRepo("src/proxy.ts");
const nextConfigSrc = readRepo("next.config.ts");
check(
  "navigation origin helper does not hard-code a Preview URL",
  !/collpro-reno-git-/.test(originSrc) && !originSrc.includes("fdb37d"),
);
check(
  "auth proxy redirects through navigationRedirectUrl, not request.url",
  proxySrc.includes("navigationRedirectUrl") &&
    !proxySrc.includes('new URL("/sign-in", request.url)') &&
    !proxySrc.includes('new URL("/dashboard", request.url)'),
);
check(
  "Server Actions allow Preview *.vercel.app origins",
  nextConfigSrc.includes('allowedOrigins: ["*.vercel.app"]'),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
