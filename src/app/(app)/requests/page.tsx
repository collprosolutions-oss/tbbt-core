import type { Metadata } from "next";
import Link from "next/link";
import { CreateEstimateButton } from "@/components/estimates/create-estimate-button";
import { Button } from "@/components/ui/button";
import { requireBusinessAccess } from "@/lib/access";
import { prisma } from "@/lib/prisma";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = {
  title: "Requests",
};

export default async function RequestsPage() {
  const access = await requireBusinessAccess();
  const requests = await prisma.serviceRequest.findMany({
    where: access.scope,
    include: {
      customer: { select: { name: true, email: true, phone: true } },
      property: { select: { addressLine1: true } },
      estimates: {
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Service requests for {access.workspace.business.name}. Public form:
          /r/{access.workspace.business.slug}
        </p>
      </div>

      {requests.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No requests yet</CardTitle>
            <CardDescription>
              Public intake submissions for this workspace will appear here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((request) => (
            <Card key={request.id}>
              <CardHeader>
                <CardTitle>{request.customer?.name ?? "Customer"}</CardTitle>
                <CardDescription>
                  {request.createdAt.toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>{request.description || "No description"}</p>
                {request.property?.addressLine1 ? (
                  <p className="text-muted-foreground">
                    {request.property.addressLine1}
                  </p>
                ) : null}
                <div className="pt-2">
                  {request.estimates[0] ? (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/estimates/${request.estimates[0].id}`}>
                        Open estimate
                      </Link>
                    </Button>
                  ) : (
                    <CreateEstimateButton serviceRequestId={request.id} />
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
