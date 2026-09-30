/**
 * Owner-configurable customer-facing business contact.
 *
 * Phone / email / website are stored on Business and shown on estimates,
 * invoices, and the public site. They are not financial snapshot fields:
 * SENT/APPROVED line items stay frozen; contact can be corrected for the
 * next customer view without rewriting prices.
 *
 * Preview shares Production and skips migrate. Request paths fail closed
 * when these additive columns are missing. They must not ADD COLUMN.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { formatPublicPhoneDisplay } from "@/lib/format";
import { isUsableEmail } from "@/lib/mail";
import {
  COLLPRO_RENO_PHONE,
  isCollProRenoSlug,
} from "@/lib/public-site";
import { assertRequiredColumnsExist } from "@/lib/request-path-schema";

type ContactClient = PrismaClient | Prisma.TransactionClient;

export const BUSINESS_PUBLIC_CONTACT_COLUMNS = [
  "publicPhone",
  "publicEmail",
  "publicWebsite",
  "publicServiceAreaLabel",
] as const;

let ensureSchemaPromise: Promise<void> | null = null;

export function resetBusinessPublicContactSchemaEnsure() {
  ensureSchemaPromise = null;
}

export async function ensureBusinessPublicContactSchema(db: ContactClient) {
  if (!ensureSchemaPromise) {
    ensureSchemaPromise = assertRequiredColumnsExist(
      db,
      "Business",
      [...BUSINESS_PUBLIC_CONTACT_COLUMNS],
    ).catch((error) => {
      ensureSchemaPromise = null;
      throw error;
    });
  }
  await ensureSchemaPromise;
}

export type BusinessPublicContactInput = {
  slug: string;
  publicPhone?: string | null;
  publicEmail?: string | null;
  publicWebsite?: string | null;
};

export type BusinessPublicContact = {
  phone: string | null;
  email: string | null;
  website: string | null;
};

const PHONE_PATTERN = /^[0-9+().\-\s]{7,40}$/;

export function parsePublicPhone(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (!PHONE_PATTERN.test(trimmed)) {
    throw new Error("Enter a valid phone number.");
  }
  return trimmed;
}

export function parsePublicEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (!isUsableEmail(trimmed) || trimmed.length > 120) {
    throw new Error("Enter a valid email address.");
  }
  return trimmed;
}

export function parsePublicServiceAreaLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (trimmed.length > 120) {
    throw new Error("Service area is too long.");
  }
  return trimmed;
}

export function parsePublicWebsite(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Enter a website URL that starts with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Enter a website URL that starts with https://");
  }
  if (trimmed.length > 200) {
    throw new Error("Website URL is too long.");
  }
  return trimmed.replace(/\/$/, "");
}

function fallbackPhoneForSlug(slug: string) {
  return isCollProRenoSlug(slug) ? COLLPRO_RENO_PHONE : null;
}

/**
 * Stored owner values win. CollPro Reno keeps its existing public phone
 * until the owner saves one. Other businesses show no phone until saved.
 * No invented email or website.
 */
export function resolveBusinessPublicContact(
  input: BusinessPublicContactInput,
): BusinessPublicContact {
  const storedPhone = input.publicPhone?.trim() || null;
  const storedEmail = input.publicEmail?.trim() || null;
  const storedWebsite = input.publicWebsite?.trim() || null;
  return {
    phone: formatPublicPhoneDisplay(storedPhone || fallbackPhoneForSlug(input.slug)),
    email: storedEmail,
    website: storedWebsite,
  };
}

export const BUSINESS_PUBLIC_CONTACT_SELECT = {
  publicPhone: true,
  publicEmail: true,
  publicWebsite: true,
  publicServiceAreaLabel: true,
} as const;

export function contactFromBusinessRow(
  business: BusinessPublicContactInput,
): BusinessPublicContact {
  return resolveBusinessPublicContact(business);
}

/**
 * Authenticated workspace memberships include the full Business row.
 * Fail closed if public contact columns are missing. Do not ADD them.
 */
export async function loadActiveWorkspaceMemberships(
  db: ContactClient,
  userId: string,
) {
  await ensureBusinessPublicContactSchema(db);
  return db.membership.findMany({
    where: { userId, active: true },
    include: { business: true },
    orderBy: { createdAt: "asc" },
  });
}
