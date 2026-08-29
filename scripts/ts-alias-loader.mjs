/**
 * Tiny Node ESM loader hook so a plain `node --experimental-strip-types`
 * script can import a src/lib/*.ts module that itself uses this repo's
 * "@/..." TypeScript path alias (see the `paths` entry in tsconfig.json).
 * Next.js's bundler resolves that alias at build time; a plain Node script
 * has no bundler, so this hook rewrites "@/x" -> "<repoRoot>/src/x.ts"
 * before handing resolution back to Node's default loader.
 *
 * Registered via `module.register()` from check-schedule-calendar.mjs --
 * see that script's header for why (it imports src/lib/schedule.ts, which
 * imports src/lib/job-schedule.ts via the "@/lib/job-schedule" alias, on
 * purpose, so the calendar's conflict detection reuses the EXACT same
 * schedulesOverlap() the real scheduleJob() server action already uses).
 */
const repoRoot = new URL("../", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = new URL(`src/${specifier.slice(2)}.ts`, repoRoot);
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
