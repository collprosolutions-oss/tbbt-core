import { FieldShell } from "@/components/field/field-shell";
import { requireWorkspace } from "@/lib/workspace";

/**
 * Employee Field Workflow layout. Any authenticated member of a business
 * may render this shell -- it is scoped by ASSIGNMENT (per Job), not by
 * role, so OWNER/ADMIN may also open it to preview a Field Job they have
 * assigned to themselves (see the OWNER / ADMIN FIELD ACCESS section of the
 * spec). This is the seam that keeps MEMBER out of the OWNER/ADMIN
 * management console: it never imports or renders <AppShell>, and every
 * page under it fetches only field-safe, assignment-scoped data.
 */
export default async function FieldLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspace = await requireWorkspace();

  return (
    <FieldShell
      businessName={workspace.business.name}
      userName={workspace.user.name}
    >
      {children}
    </FieldShell>
  );
}
