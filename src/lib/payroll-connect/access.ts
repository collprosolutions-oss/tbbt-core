import type { MembershipRole } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, ForbiddenError, requireBusinessCapability } from "@/lib/authorization";

export type PayrollConnectAccess = {
  businessId: string;
  workspace: {
    role: MembershipRole;
    membership: { id: string };
  };
  scope: { readonly businessId: string };
  assertOwned: BusinessAccess["assertOwned"];
};

export function requirePayrollConnectOwner(access: PayrollConnectAccess) {
  requireBusinessCapability(access as BusinessAccess, CAPABILITIES.CONNECT_PAYROLL_PROVIDER);
  if (access.scope.businessId !== access.businessId) {
    throw new ForbiddenError();
  }
}
