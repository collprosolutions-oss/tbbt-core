/**
 * Vercel Preview and the unused `workspace` project share DATABASE_URL
 * with live collpro-reno Production. Running `prisma migrate deploy` on
 * every build contends for PostgreSQL advisory lock 72707369 (P1002).
 *
 * Preview and local `npm run build` skip migrate. Production migrate
 * runs only on the collpro-reno Vercel project. Prisma locking stays on.
 */
import { spawnSync } from "node:child_process";
import { shouldRunProductionMigrate } from "./production-migrate-policy.mjs";

const decision = shouldRunProductionMigrate({
  vercelEnv: process.env.VERCEL_ENV,
  projectId: process.env.VERCEL_PROJECT_ID,
  projectName: process.env.VERCEL_PROJECT_NAME,
  productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
});

if (!decision.run) {
  console.log(`Skipping prisma migrate deploy (${decision.reason}).`);
  process.exit(0);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
