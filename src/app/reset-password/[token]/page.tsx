import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { lookupUsablePasswordResetToken } from "@/lib/password-reset";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = {
  title: "Reset your password",
};

/**
 * Public password-recovery page. Looked up by the raw token's HASH alone
 * (same pattern as /set-password/[token]). Invalid, used, expired, or
 * malformed tokens all render the same generic message -- this page never
 * reveals whether a given token was ever real and never shows business,
 * tenant, or account data.
 */
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resetToken = await lookupUsablePasswordResetToken(prisma, token);

  return (
    <main className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Reset your password</CardTitle>
          <CardDescription>
            {resetToken
              ? "Choose a new password for your TBBT account."
              : "This reset link is invalid or has expired. Request a new one from the sign-in page."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {resetToken ? (
            <ResetPasswordForm token={token} />
          ) : (
            <Link
              href="/forgot-password"
              className="text-sm underline underline-offset-4"
            >
              Request a new reset link
            </Link>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
