/**
 * Vercel Preview and Production share DATABASE_URL. Running
 * `prisma migrate deploy` on every Preview build contends for the
 * PostgreSQL advisory lock (P1002) and can fail the Preview deploy.
 *
 * Migrations run only when Vercel is building Production.
 * Preview and local `npm run build` still run `prisma generate` and
 * `next build`. Apply schema changes with `npm run db:deploy` or by
 * deploying to Production.
 */
import { spawnSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV || "local";
if (vercelEnv !== "production") {
  console.log(`Skipping prisma migrate deploy (${vercelEnv} build).`);
  process.exit(0);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
