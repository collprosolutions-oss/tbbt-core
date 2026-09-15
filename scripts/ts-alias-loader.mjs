/**
 * Tiny Node ESM loader hook so a plain `node --experimental-strip-types`
 * script can import a src/lib/*.ts module that itself uses this repo's
 * "@/..." TypeScript path alias (see the `paths` entry in tsconfig.json).
 * Next.js's bundler resolves that alias at build time; a plain Node script
 * has no bundler, so this hook rewrites "@/x" -> "<repoRoot>/src/x.ts"
 * (or "<repoRoot>/src/x/index.ts" for directory barrels) before handing
 * resolution back to Node's default loader.
 *
 * Registered via `module.register()` from check-schedule-calendar.mjs --
 * see that script's header for why (it imports src/lib/schedule.ts, which
 * imports src/lib/job-schedule.ts via the "@/lib/job-schedule" alias, on
 * purpose, so the calendar's conflict detection reuses the EXACT same
 * schedulesOverlap() the real scheduleJob() server action already uses).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const fileTarget = new URL(`src/${specifier.slice(2)}.ts`, repoRoot);
    const indexTarget = new URL(`src/${specifier.slice(2)}/index.ts`, repoRoot);
    const target = existsSync(fileURLToPath(fileTarget)) ? fileTarget : indexTarget;
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
