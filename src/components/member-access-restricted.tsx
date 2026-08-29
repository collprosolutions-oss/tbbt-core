import { signOutAction } from "@/app/actions/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Safe, minimal landing state for a MEMBER whose account has no
 * management-console read access yet (see
 * `canAccessManagementConsole()` in src/lib/authorization.ts). This is
 * intentionally NOT a dashboard or field UI -- just enough for the member
 * to understand their account is active and sign out. Rendered instead of
 * `<AppShell>` (no sidebar/nav), so no management navigation or data is
 * ever sent to a MEMBER.
 */
export function MemberAccessRestricted({
  businessName,
  userName,
  userEmail,
}: {
  businessName: string;
  userName: string;
  userEmail: string;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Access restricted</CardTitle>
          <CardDescription>
            Your {businessName} account does not have access to management
            pages yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1 text-sm">
            <p className="font-medium">{userName}</p>
            <p className="text-muted-foreground">{userEmail}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            Ask your business owner or admin if you believe this is a
            mistake.
          </p>
          <form action={signOutAction}>
            <Button type="submit" variant="outline" className="w-full">
              Sign out
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
