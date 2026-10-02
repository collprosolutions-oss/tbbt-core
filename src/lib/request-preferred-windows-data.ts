/**
 * Tenant-scoped reads of customer preferred windows.
 *
 * Never trust a browser-supplied businessId. Job reads follow
 * Estimate.serviceRequestId and re-check ServiceRequest.businessId.
 */
import type { BusinessAccess } from "@/lib/access";
import {
  ownerPreferredWindowsFromDescription,
  type OwnerPreferredWindowsView,
} from "@/lib/request-preferred-windows";

type PreferredWindowsDb = {
  serviceRequest: {
    findFirst: (args: {
      where: { id: string; businessId: string };
      select: { id: true; businessId: true; description: true; tradeCode: true };
    }) => Promise<{
      id: string;
      businessId: string;
      description: string | null;
      tradeCode: string;
    } | null>;
  };
  job: {
    findFirst: (args: {
      where: { id: string; businessId: string };
      select: {
        id: true;
        businessId: true;
        estimate: {
          select: {
            id: true;
            businessId: true;
            serviceRequestId: true;
            serviceRequest: {
              select: {
                id: true;
                businessId: true;
                description: true;
                tradeCode: true;
              };
            };
          };
        };
      };
    }) => Promise<{
      id: string;
      businessId: string;
      estimate: {
        id: string;
        businessId: string;
        serviceRequestId: string | null;
        serviceRequest: {
          id: string;
          businessId: string;
          description: string | null;
          tradeCode: string;
        } | null;
      } | null;
    } | null>;
  };
};

export async function loadOwnedRequestPreferredWindows(
  db: PreferredWindowsDb,
  access: Pick<BusinessAccess, "businessId" | "scope" | "assertOwned">,
  requestId: string,
  now?: Date,
): Promise<OwnerPreferredWindowsView | null> {
  const id = requestId.trim();
  if (!id) return null;
  const request = await db.serviceRequest.findFirst({
    where: { id, ...access.scope, businessId: access.businessId },
    select: { id: true, businessId: true, description: true, tradeCode: true },
  });
  if (!request || request.businessId !== access.businessId) return null;
  return ownerPreferredWindowsFromDescription(request.description, now);
}

export async function loadOwnedJobPreferredWindows(
  db: PreferredWindowsDb,
  access: Pick<BusinessAccess, "businessId" | "scope" | "assertOwned">,
  jobId: string,
  now?: Date,
): Promise<OwnerPreferredWindowsView | null> {
  const id = jobId.trim();
  if (!id) return null;
  const job = await db.job.findFirst({
    where: { id, ...access.scope, businessId: access.businessId },
    select: {
      id: true,
      businessId: true,
      estimate: {
        select: {
          id: true,
          businessId: true,
          serviceRequestId: true,
          serviceRequest: {
            select: {
              id: true,
              businessId: true,
              description: true,
              tradeCode: true,
            },
          },
        },
      },
    },
  });
  if (!job || job.businessId !== access.businessId) return null;
  const request = job.estimate?.serviceRequest;
  if (!request || request.businessId !== access.businessId) return null;
  if (job.estimate?.serviceRequestId !== request.id) return null;
  if (job.estimate.businessId !== access.businessId) return null;
  return ownerPreferredWindowsFromDescription(request.description, now);
}

export function preferredWindowsFromOwnedRequest(input: {
  businessId: string;
  requestBusinessId?: string | null;
  description?: string | null;
  now?: Date;
}) {
  if (!input.requestBusinessId || input.requestBusinessId !== input.businessId) {
    return null;
  }
  return ownerPreferredWindowsFromDescription(input.description, input.now);
}
