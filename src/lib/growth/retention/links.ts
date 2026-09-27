import type { MembershipRole } from "@prisma/client";
import { recordHref, recordNavKindAllowed, type RecordNavKind } from "@/lib/record-nav";
import type { RetentionLink } from "@/lib/growth/retention/types";

export function sameTenantRecordHref(
  kind: RecordNavKind,
  id: string,
  recordBusinessId: string,
  accessBusinessId: string,
  role: MembershipRole,
  customerId?: string | null,
): string | null {
  if (recordBusinessId !== accessBusinessId) return null;
  if (!recordNavKindAllowed(role, kind)) return null;
  return recordHref(kind, id, customerId);
}

export function sameTenantCommunicationsHref(
  customerId: string,
  recordBusinessId: string,
  accessBusinessId: string,
): string | null {
  if (recordBusinessId !== accessBusinessId) return null;
  return `/communications?customerId=${encodeURIComponent(customerId)}`;
}

export function pushLink(links: RetentionLink[], href: string | null, label: string) {
  if (!href) return;
  links.push({ href, label });
}
