import type { PublishedTrade } from "@/lib/website-engine/snapshot";

export function publishedTradeLabels(trades: Array<{ label?: string; customerFacingLabel?: string }>) {
  return trades
    .map((trade) => (trade.customerFacingLabel || trade.label || "").trim())
    .filter(Boolean);
}

export function publishedTradePhrase(trades: Array<{ label?: string; customerFacingLabel?: string }>) {
  const labels = publishedTradeLabels(trades);
  if (labels.length === 0) return "Services";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function publishedServicesHeadline(trades: PublishedTrade[] | Array<{ label?: string; customerFacingLabel?: string }>) {
  return `${publishedTradePhrase(trades)} Services You Can Count On`;
}

export function publishedLocalBusinessDescription(input: {
  name: string;
  trades: Array<{ label?: string; customerFacingLabel?: string }>;
  area?: string | null;
}) {
  const phrase = publishedTradePhrase(input.trades);
  const area = input.area?.trim();
  if (area) {
    return `${phrase} from ${input.name} in ${area}.`;
  }
  return `${phrase} from ${input.name}.`;
}

export function publishedServicesHeroDescription(input: {
  name: string;
  trades: Array<{ label?: string; customerFacingLabel?: string }>;
}) {
  return `${publishedTradePhrase(input.trades)} from ${input.name}. Select one or more tasks, then continue to request service.`;
}

export function publishedRequestAccent(
  trades: Array<{ label?: string; customerFacingLabel?: string }>,
) {
  return `Let's get your ${publishedTradePhrase(trades).toLowerCase()} request started.`;
}

export function publishedProjectsDescription(input: {
  name: string;
  trades: Array<{ label?: string; customerFacingLabel?: string }>;
}) {
  return `Recent ${publishedTradePhrase(input.trades).toLowerCase()} work from ${input.name}.`;
}

export function publishedHeroImageAlt(
  trades: Array<{ label?: string; customerFacingLabel?: string }>,
) {
  return `${publishedTradePhrase(trades)} work`;
}

export function snapshotContainsHandymanClaim(text: string) {
  return /handyman/i.test(text);
}
