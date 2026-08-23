import { AppShell } from "@/components/app-shell";
import { getTrade } from "@/lib/trades";
import { requireWorkspace } from "@/lib/workspace";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspace = await requireWorkspace();
  const trade = getTrade(workspace.business.tradeCode);

  return (
    <AppShell
      businessName={workspace.business.name}
      tradeLabel={trade?.name ?? "Handyman"}
      userName={workspace.user.name}
      userEmail={workspace.user.email}
      role={workspace.role}
    >
      {children}
    </AppShell>
  );
}
