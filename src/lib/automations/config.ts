import { CONFIGURATION_RECORDED_LABEL } from "@/lib/automations/types";
import type { SafeAutomationConfig } from "@/lib/automations/types";

const CHANNEL_LABELS: Record<string, string> = {
  EMAIL: "Email",
  SMS: "Text message (SMS)",
  BOTH: "Email and text message",
  NONE: "No customer message channel",
};

function delayLabel(delayMinutes: number): string {
  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) return "No delay";
  if (delayMinutes === 60) return "1 hour";
  if (delayMinutes === 24 * 60) return "1 day";
  if (delayMinutes % (24 * 60) === 0) {
    const days = delayMinutes / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (delayMinutes % 60 === 0) {
    const hours = delayMinutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${delayMinutes} minutes`;
}

function channelLabel(channel: string): string | null {
  return CHANNEL_LABELS[channel] ?? null;
}

/**
 * Whitelist-only projection of recorded rule settings.
 *
 * Live AutomationRule has no JSON `config` column. Extra objects (including
 * planted secrets or a hypothetical config blob) are ignored and never copied.
 */
export function projectSafeAutomationConfig(
  recorded: { channel: string; delayMinutes: number; kind: string },
  extraConfig?: unknown,
): SafeAutomationConfig {
  void extraConfig;
  const channel = channelLabel(recorded.channel);
  const delay = Number.isFinite(recorded.delayMinutes)
    ? delayLabel(recorded.delayMinutes)
    : null;

  if (recorded.kind === "ACTION_SUGGESTION") {
    return {
      summary: delay
        ? `Owner-action suggestion. No customer message is sent. ${delay}.`
        : "Owner-action suggestion. No customer message is sent.",
      channelLabel: channel,
      delayLabel: delay,
    };
  }

  if (channel && delay) {
    return {
      summary: `${channel}. ${delay}.`,
      channelLabel: channel,
      delayLabel: delay,
    };
  }

  return {
    summary: CONFIGURATION_RECORDED_LABEL,
    channelLabel: channel,
    delayLabel: delay,
  };
}

export function projectionTextContains(value: unknown, needle: string): boolean {
  if (!needle) return false;
  return JSON.stringify(value).includes(needle);
}
