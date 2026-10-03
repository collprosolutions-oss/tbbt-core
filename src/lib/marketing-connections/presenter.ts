/**
 * Per-destination connection cards. Each card is derived only from that
 * destination's record. An unconnected Instagram or Google card cannot
 * change the Facebook card, and the reverse is also true.
 *
 * Instagram and Google publish stay unavailable: connecting does not post.
 */
import {
  MARKETING_CONNECTION_DESTINATIONS,
  MARKETING_CONNECTION_LABELS,
  type MarketingConnectionDestination,
  type MarketingConnectionStatus,
  type MarketingDestinationAvailability,
} from "@/lib/marketing-connections/config";

export type MarketingConnectionSummary = {
  destination: MarketingConnectionDestination;
  connectionStatus: string;
  displayName: string;
  lastError: string;
  remoteRevokeNote: string;
  publishable: boolean;
  legacyPlaintext: boolean;
  hasRow: boolean;
};

export type MarketingConnectionCard = {
  destination: MarketingConnectionDestination;
  label: string;
  status: MarketingConnectionStatus;
  statusLabel: string;
  detail: string;
  displayName: string;
  publishAvailable: boolean;
  showConnect: boolean;
  showReconnect: boolean;
  showDisconnect: boolean;
  showStatusCheck: boolean;
};

const PUBLISH_NOT_AVAILABLE =
  "Publishing is not yet available. Connecting does not post, and an approved package is still required before any later publish.";

function needsMorePermission(lastError: string) {
  return lastError.trim().toLowerCase().startsWith("needs more permission");
}

function cardForDestination(
  destination: MarketingConnectionDestination,
  summary: MarketingConnectionSummary | undefined,
  availability: MarketingDestinationAvailability,
  owner: boolean,
): MarketingConnectionCard {
  const label = MARKETING_CONNECTION_LABELS[destination];
  const base = {
    destination,
    label,
    displayName: summary?.displayName?.trim() ?? "",
    publishAvailable: destination === "FACEBOOK" && summary?.publishable === true,
  };

  const platformReady = availability.available;
  if (!summary?.hasRow && !platformReady) {
    return {
      ...base,
      status: "NOT_CONFIGURED",
      statusLabel: "Not available",
      detail: availability.message,
      publishAvailable: false,
      showConnect: false,
      showReconnect: false,
      showDisconnect: false,
      showStatusCheck: false,
    };
  }

  const status = (summary?.connectionStatus ?? "") as string;
  const lastError = summary?.lastError?.trim() ?? "";
  const permission = needsMorePermission(lastError);

  if (!summary?.hasRow || status === "NOT_CONFIGURED") {
    return {
      ...base,
      status: "NOT_CONFIGURED",
      statusLabel: "Not connected",
      detail: platformReady
        ? destination === "FACEBOOK"
          ? "No Facebook Page is connected. Connect does not publish."
          : `${label} is not connected. ${PUBLISH_NOT_AVAILABLE}`
        : availability.message,
      showConnect: owner && platformReady,
      showReconnect: false,
      showDisconnect: false,
      showStatusCheck: false,
    };
  }

  if (summary.legacyPlaintext && status !== "DISCONNECTED" && status !== "CONNECTED") {
    return {
      ...base,
      status: "NEEDS_RECONNECT",
      statusLabel: "Needs reconnect",
      detail:
        "A legacy Facebook Page token is stored without encryption. Reconnect to replace it. This card does not publish. The existing OWNER publish click still requires an approved package.",
      showConnect: false,
      showReconnect: owner && platformReady,
      showDisconnect: owner,
      showStatusCheck: owner && platformReady,
    };
  }

  if (status === "DISCONNECTED") {
    return {
      ...base,
      status: "DISCONNECTED",
      statusLabel: "Disconnected",
      detail: summary.remoteRevokeNote.trim() || `${label} is disconnected. Local tokens were wiped. Connect does not publish.`,
      publishAvailable: false,
      showConnect: owner && platformReady,
      showReconnect: owner && platformReady,
      showDisconnect: false,
      showStatusCheck: false,
    };
  }

  if (status === "EXPIRED") {
    return {
      ...base,
      status: "EXPIRED",
      statusLabel: "Expired",
      detail: lastError || `${label} token is expired. Reconnect before any publish. Nothing was posted.`,
      publishAvailable: false,
      showConnect: false,
      showReconnect: owner && platformReady,
      showDisconnect: owner,
      showStatusCheck: owner && platformReady,
    };
  }

  if (status === "NEEDS_RECONNECT" || permission) {
    return {
      ...base,
      status: "NEEDS_RECONNECT",
      statusLabel: permission ? "Needs more permission" : "Needs reconnect",
      detail: lastError || `${label} needs the OWNER to reconnect. Nothing was posted.`,
      publishAvailable: false,
      showConnect: false,
      showReconnect: owner && platformReady,
      showDisconnect: owner,
      showStatusCheck: owner && platformReady,
    };
  }

  if (status === "CONNECTED") {
    const name = summary.displayName.trim();
    const publishDetail =
      destination === "FACEBOOK"
        ? "Connected. Publishing still requires an OWNER-approved package and an explicit OWNER publish click. Connect did not post."
        : `Connected${name ? ` to ${name}` : ""}. ${PUBLISH_NOT_AVAILABLE}`;
    const approval =
      destination === "GOOGLE"
        ? " Google must approve Business Profile API access before live calls succeed. This screen does not claim that approval."
        : destination === "INSTAGRAM"
          ? " Instagram content publishing needs Meta app review for instagram_content_publish before a later publish can succeed."
          : " Facebook posting needs Meta app review for pages_manage_posts before a Page outside Development mode can be posted to.";
    return {
      ...base,
      status: "CONNECTED",
      statusLabel: "Connected",
      detail: `${publishDetail}${approval}`,
      showConnect: false,
      showReconnect: owner && platformReady,
      showDisconnect: owner,
      showStatusCheck: owner && platformReady,
    };
  }

  return {
    ...base,
    status: "NOT_CONFIGURED",
    statusLabel: "Not connected",
    detail: `${label} is not connected.`,
    publishAvailable: false,
    showConnect: owner,
    showReconnect: false,
    showDisconnect: false,
    showStatusCheck: false,
  };
}

export function presentMarketingConnectionCards(input: {
  summaries: readonly MarketingConnectionSummary[];
  availability: Record<MarketingConnectionDestination, MarketingDestinationAvailability>;
  owner: boolean;
}): MarketingConnectionCard[] {
  return MARKETING_CONNECTION_DESTINATIONS.map((destination) =>
    cardForDestination(
      destination,
      input.summaries.find((row) => row.destination === destination),
      input.availability[destination],
      input.owner,
    ),
  );
}
