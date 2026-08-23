import type { Metadata } from "next";
import { ApproveEstimateButton } from "@/components/estimates/approve-estimate-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Estimate",
};

export default async function PublicEstimatePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const estimate = await prisma.estimate.findUnique({
    where: { publicToken: token },
    select: {
      publicToken: true,
      status: true,
      total: true,
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          description: true,
          quantity: true,
          unitPrice: true,
          total: true,
        },
      },
    },
  });

  if (!estimate) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Estimate unavailable</CardTitle>
            <CardDescription>This estimate is not available.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Estimate</CardTitle>
          <CardDescription>Total {estimate.total.toString()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {estimate.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {estimate.lineItems.map((item, index) => (
                <li key={index} className="flex justify-between gap-3">
                  <span>
                    {item.description} × {item.quantity.toString()} @{" "}
                    {item.unitPrice.toString()}
                  </span>
                  <span>{item.total.toString()}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm font-medium">
            Estimate total: {estimate.total.toString()}
          </p>
          <ApproveEstimateButton
            publicToken={estimate.publicToken}
            status={estimate.status}
          />
        </CardContent>
      </Card>
    </main>
  );
}
