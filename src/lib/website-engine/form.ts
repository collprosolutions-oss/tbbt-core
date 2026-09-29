import type { PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { WebsitePublishError } from "@/lib/website-engine/builder";
import {
  publishWebsite,
  restoreOwnedWebsitePublish,
  rollbackWebsite,
} from "@/lib/website-engine/publish";

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

function readFormFlag(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "on" || normalized === "true";
}

export async function restoreWebsiteFromForm(
  db: PrismaClient,
  access: BusinessAccess,
  formData: FormData,
) {
  const publishId = typeof formData.get("publishId") === "string" ? String(formData.get("publishId")).trim() : "";
  const expectedCurrentId =
    typeof formData.get("expectedCurrentId") === "string"
      ? String(formData.get("expectedCurrentId")).trim()
      : "";
  return restoreOwnedWebsitePublish(db, access, {
    publishId,
    expectedCurrentId,
    confirmed: readFormFlag(formData, "confirmed"),
  });
}
