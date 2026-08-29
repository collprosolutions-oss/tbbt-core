import type { Metadata } from "next";
import Link from "next/link";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { hashToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Set your password",
};

/**
 * Public onboarding page for a brand-new team member -- see addTeamMember()
 * in src/app/actions/team.ts. Looked up by the raw token's HASH alone
 * (mirrors every other token-scoped public page: /p/[token], /e/[token]).
 *
 * SECURITY: an invalid, already-used, or expired token all render the
 * exact same generic message -- this page never reveals whether a given
 * token string was ever real, and (unlike the Team page) never queries or
 * displays any business-wide data; the one detail shown for a VALID token
 * (the business name the caller is being onboarded into) is exactly what
 * the person holding this unguessable, single-use link is meant to see.
 */
export default async function SetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const setupToken = await prisma.passwordSetupToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      usedAt: true,
      expiresAt: true,
      user: {
        select: {
          name: true,
          memberships: {
            where: { active: true },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { business: { select: { name: true } } },
          },
        },
      },
    },
  });

  const isValid = Boolean(
    setupToken && !setupToken.usedAt && setupToken.expiresAt > new Date(),
  );

  const businessName = setupToken?.user.memberships[0]?.business.name ?? null;
  const memberName = setupToken?.user.name ?? null;

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set your password</CardTitle>
          <CardDescription>
            {isValid
              ? `Welcome${memberName ? `, ${memberName}` : ""}${
                  businessName ? ` — you've been added to ${businessName}` : ""
                }. Choose a password to finish setting up your account.`
              : "This setup link is invalid or has expired. Ask your business owner or admin for a new one."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isValid ? (
            <SetPasswordForm token={token} />
          ) : (
            <Link
              href="/sign-in"
              className="text-sm underline underline-offset-4"
            >
              Go to sign in
            </Link>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
