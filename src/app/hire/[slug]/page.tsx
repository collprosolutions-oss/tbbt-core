import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Hire a handyman",
};

const SERVICES = [
  "Leaky faucets and fixture swaps",
  "Doors, locks, and hardware",
  "Drywall patches and punch-list repairs",
  "TV mounting and shelf installs",
  "Interior trim, caulk, and small carpentry",
];

export default async function PublicHirePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const business = await prisma.business.findUnique({
    where: { slug: slug.trim().toLowerCase() },
    select: { name: true, slug: true },
  });

  if (!business) {
    return (
      <main className="flex min-h-full items-center justify-center px-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Page unavailable</CardTitle>
            <CardDescription>This business could not be found.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="px-4 py-10">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Handyman</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {business.name}
          </h1>
          <p className="mt-3 text-base text-muted-foreground">
            Local repairs, installs, and punch-list work done from a clear
            estimate. Tell us what is broken. We send a price before anyone
            shows up.
          </p>
        </div>

        <Button asChild size="lg" className="w-full">
          <Link href={`/r/${business.slug}`}>Request Service</Link>
        </Button>

        <Card>
          <CardHeader>
            <CardTitle>Typical jobs</CardTitle>
            <CardDescription>
              Common handyman work this crew handles.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              {SERVICES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>About this crew</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {business.name} is a local handyman business. You get a written
              estimate first, then a scheduled visit after you approve the
              price.
            </p>
            <p>
              No surprise invoices. The number on the estimate is the number
              on the bill.
            </p>
          </CardContent>
        </Card>

        <Button asChild size="lg" className="w-full">
          <Link href={`/r/${business.slug}`}>Request Service</Link>
        </Button>
      </div>
    </main>
  );
}
