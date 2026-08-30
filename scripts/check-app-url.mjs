/**
 * Focused check for getAppUrl() preview-safe resolution.
 *
 * NEXT_PUBLIC_APP_URL wins when set (production: www.collproreno.com).
 * When it is absent on a Vercel preview, only platform-supplied
 * VERCEL_URL / VERCEL_BRANCH_URL hostnames on *.vercel.app are used.
 * Request Host headers are never read.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-app-url.mjs
 */
import { register } from "node:module";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { getAppUrl } = await import("@/lib/mail");

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

const saved = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
  VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
};

function setEnv(map) {
  for (const key of Object.keys(saved)) {
    if (map[key] === undefined || map[key] === null) {
      delete process.env[key];
    } else {
      process.env[key] = map[key];
    }
  }
}

function restore() {
  setEnv(saved);
}

console.log("\nSTATIC — getAppUrl resolution");

setEnv({
  NEXT_PUBLIC_APP_URL: "https://www.collproreno.com",
  VERCEL_ENV: "preview",
  VERCEL_URL: "collpro-reno-preview.vercel.app",
  VERCEL_BRANCH_URL: "collpro-reno-git-cursor-time-cards-cd0e.vercel.app",
});
check(
  "explicit NEXT_PUBLIC_APP_URL wins over Vercel preview hosts (production canonical)",
  getAppUrl() === "https://www.collproreno.com",
);

setEnv({
  NEXT_PUBLIC_APP_URL: "https://www.collproreno.com/app/",
  VERCEL_ENV: "production",
  VERCEL_URL: null,
  VERCEL_BRANCH_URL: null,
});
check(
  "NEXT_PUBLIC_APP_URL origin is used and trailing slash is stripped",
  getAppUrl() === "https://www.collproreno.com/app",
);

setEnv({
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "preview",
  VERCEL_URL: "collpro-reno-abc123-collpro-s-projects5.vercel.app",
  VERCEL_BRANCH_URL: "collpro-reno-git-cursor-time-cards-cd0e-collpro-s-projects5.vercel.app",
});
check(
  "preview without NEXT_PUBLIC_APP_URL uses VERCEL_BRANCH_URL",
  getAppUrl() ===
    "https://collpro-reno-git-cursor-time-cards-cd0e-collpro-s-projects5.vercel.app",
);

setEnv({
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "preview",
  VERCEL_URL: "collpro-reno-abc123-collpro-s-projects5.vercel.app",
  VERCEL_BRANCH_URL: null,
});
check(
  "preview falls back to VERCEL_URL when branch URL is absent",
  getAppUrl() === "https://collpro-reno-abc123-collpro-s-projects5.vercel.app",
);

setEnv({
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "production",
  VERCEL_URL: "collpro-reno-abc123-collpro-s-projects5.vercel.app",
  VERCEL_BRANCH_URL: null,
});
check(
  "production does not silently adopt a Vercel deployment host",
  getAppUrl() === null,
);

setEnv({
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "preview",
  VERCEL_URL: "evil.example.com",
  VERCEL_BRANCH_URL: "https://evil.example.com",
});
check(
  "non-vercel.app and URL-shaped values are rejected",
  getAppUrl() === null,
);

setEnv({
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: "preview",
  VERCEL_URL: "collpro-reno.vercel.app/steal",
  VERCEL_BRANCH_URL: "user@collpro-reno.vercel.app",
});
check(
  "hosts with a path or userinfo are rejected",
  getAppUrl() === null,
);

setEnv({
  NEXT_PUBLIC_APP_URL: "javascript:alert(1)",
  VERCEL_ENV: null,
  VERCEL_URL: null,
  VERCEL_BRANCH_URL: null,
});
check("non-http NEXT_PUBLIC_APP_URL is rejected", getAppUrl() === null);

setEnv({
  NEXT_PUBLIC_APP_URL: null,
  VERCEL_ENV: null,
  VERCEL_URL: "collpro-reno.vercel.app",
  VERCEL_BRANCH_URL: null,
});
check("no VERCEL_ENV means no preview fallback", getAppUrl() === null);

restore();

const mailSrc = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/lib/mail.ts", import.meta.url), "utf8"),
);
check(
  "getAppUrl never reads request Host / headers",
  !mailSrc.includes("headers()") && !mailSrc.includes("x-forwarded-host"),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
