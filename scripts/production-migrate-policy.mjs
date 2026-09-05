/**
 * Preview and the unused `workspace` Vercel project share DATABASE_URL
 * with live collpro-reno Production. Prisma migrate deploy takes
 * PostgreSQL advisory lock 72707369 (P1002 if contended).
 *
 * Preview already skips migrate. Production still raced because both
 * Vercel projects build with VERCEL_ENV=production on the same commit.
 * Only the collpro-reno Production project may run migrate.
 */

export const COLLPRO_RENO_VERCEL_PROJECT_ID = "prj_7xmTwilZyg0plUHRzHgvboCusHLp";
export const WORKSPACE_VERCEL_PROJECT_ID = "prj_93RU249o7PH0npog4XAuKAFZN0hd";

function hostnameOf(value) {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.split("/")[0].toLowerCase();
  }
}

export function isCollProRenoMigrateOwner({
  projectId,
  projectName,
  productionUrl,
} = {}) {
  const id = (projectId ?? "").trim();
  const name = (projectName ?? "").trim().toLowerCase();
  if (id === COLLPRO_RENO_VERCEL_PROJECT_ID) return true;
  if (id === WORKSPACE_VERCEL_PROJECT_ID) return false;
  if (name === "collpro-reno") return true;
  if (name === "workspace") return false;
  const host = hostnameOf(productionUrl);
  return (
    host === "collproreno.com" ||
    host === "www.collproreno.com" ||
    host === "collpro-reno.vercel.app"
  );
}

export function shouldRunProductionMigrate({
  vercelEnv,
  projectId,
  projectName,
  productionUrl,
} = {}) {
  const env = (vercelEnv || "local").trim() || "local";
  if (env !== "production") {
    return { run: false, reason: `${env} build` };
  }
  if (isCollProRenoMigrateOwner({ projectId, projectName, productionUrl })) {
    return { run: true, reason: "collpro-reno production" };
  }
  return { run: false, reason: "not the migrate-owner Vercel project" };
}
