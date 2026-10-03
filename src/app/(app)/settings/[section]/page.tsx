import { notFound, redirect } from "next/navigation";
import { isSettingsSection } from "@/lib/settings";
import SettingsPage from "../page";

export default async function SettingsSectionRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ section?: string; checkout?: string; oauth_state_id?: string }>;
}) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();
  const query = await searchParams;
  const oauthState = typeof query.oauth_state_id === "string" ? query.oauth_state_id.trim() : "";
  // Plaid appends oauth_state_id to the registered /settings/banking URI.
  // Stay on that path so receivedRedirectUri matches and the host-only
  // session cookie is still sent.
  if (section === "banking" && oauthState) {
    return SettingsPage({
      searchParams: Promise.resolve({
        section: "banking",
        checkout: query.checkout,
      }),
    });
  }
  redirect(`/settings?section=${encodeURIComponent(section)}`);
}
