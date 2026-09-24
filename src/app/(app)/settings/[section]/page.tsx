import { notFound, redirect } from "next/navigation";
import { isSettingsSection } from "@/lib/settings";

export default async function SettingsSectionRedirectPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();
  redirect(`/settings?section=${encodeURIComponent(section)}`);
}
