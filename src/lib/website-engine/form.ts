import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { WebsitePublishError } from "@/lib/website-engine/builder";
import { publishWebsite, rollbackWebsite } from "@/lib/website-engine/publish";

export function readWebsiteEngineIdempotencyKey(formData: FormData) {
  const value = formData.get("idempotencyKey");
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function publishWebsiteFromForm(
  db: PrismaClient,
  access: BusinessAccess,
  formData: FormData,
) {
  const idempotencyKey = readWebsiteEngineIdempotencyKey(formData);
  if (!idempotencyKey) {
    throw new WebsitePublishError("Publish attempt is missing an idempotency key.");
  }
  return publishWebsite(db, access, { idempotencyKey });
}

export async function rollbackWebsiteFromForm(
  db: PrismaClient,
  access: BusinessAccess,
  formData: FormData,
) {
  const idempotencyKey = readWebsiteEngineIdempotencyKey(formData);
  const publishId = typeof formData.get("publishId") === "string" ? String(formData.get("publishId")).trim() : "";
  if (!idempotencyKey) {
    throw new WebsitePublishError("Rollback attempt is missing an idempotency key.");
  }
  return rollbackWebsite(db, access, { publishId, idempotencyKey });
}
