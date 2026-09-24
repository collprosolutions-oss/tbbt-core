/**
 * AI-assisted marketing draft architecture.
 *
 * No external model provider is called. TBBT builds an honest TEMPLATE
 * draft from recorded job/service data. An env string never means a
 * provider is connected. Nothing here marks content PUBLISHED.
 */

export const MARKETING_DRAFT_MODES = ["TEMPLATE"] as const;
export type MarketingDraftMode = (typeof MARKETING_DRAFT_MODES)[number];

export const MARKETING_AI_DISCONNECTED_MESSAGE =
  "AI drafting is not connected. TBBT prepared a template from recorded job and service data only. Review and edit before approval.";

export const MARKETING_AI_NOT_CONNECTED_MESSAGE = MARKETING_AI_DISCONNECTED_MESSAGE;

export function marketingAiProviderConnected(): false {
  return false;
}

/** External AI is not connected. Template drafts still work. */
export function marketingAiAssistAvailable(): false {
  return false;
}

export type MarketingDraftInput = {
  contentType: "COMPLETED_JOB" | "SERVICE_HIGHLIGHT" | "GENERAL_POST" | "BLOG_SEO";
  businessName: string;
  brandVoice?: string | null;
  identityNotes?: string | null;
  customerName?: string | null;
  workPerformed?: string | null;
  serviceName?: string | null;
  city?: string | null;
  photoCount?: number;
};

export type MarketingDraft = {
  mode: MarketingDraftMode;
  title: string;
  body: string;
  message: string;
  publishable: false;
};

function voicePrefix(input: MarketingDraftInput) {
  const voice = input.brandVoice?.trim();
  return voice ? `Write in this recorded brand voice: ${voice}\n\n` : "";
}

export function draftMarketingContent(input: MarketingDraftInput): MarketingDraft {
  const business = input.businessName.trim() || "this business";
  const work = input.workPerformed?.trim() || input.serviceName?.trim() || "recent handyman work";
  const city = input.city?.trim();
  const identity = input.identityNotes?.trim();
  const photos = input.photoCount ?? 0;

  if (input.contentType === "SERVICE_HIGHLIGHT") {
    return {
      mode: "TEMPLATE",
      title: city ? `${work} in ${city}` : `${work} highlight`,
      body: `${voicePrefix(input)}${business} offers ${work}${city ? ` for homeowners in ${city}` : ""}. This draft uses recorded catalog and service-area data only.${identity ? ` ${identity}` : ""}`,
      message: MARKETING_AI_DISCONNECTED_MESSAGE,
      publishable: false,
    };
  }

  if (input.contentType === "BLOG_SEO") {
    return {
      mode: "TEMPLATE",
      title: city ? `${work} in ${city}: what homeowners should know` : `${work}: what homeowners should know`,
      body: `${voicePrefix(input)}A local-page draft for ${business} about ${work}${city ? ` in ${city}` : ""}. This is an internal SEO draft — it is not published until an owner approves it and a connected website path exists.`,
      message: MARKETING_AI_DISCONNECTED_MESSAGE,
      publishable: false,
    };
  }

  if (input.contentType === "COMPLETED_JOB") {
    return {
      mode: "TEMPLATE",
      title: `Completed ${work}`,
      body: `${voicePrefix(input)}${business} completed ${work}${city ? ` in ${city}` : ""}.${photos > 0 ? ` ${photos} marketing-approved photo${photos === 1 ? "" : "s"} can be attached.` : " No marketing-approved photos are attached yet."} Do not invent results that are not on the job record.`,
      message: MARKETING_AI_DISCONNECTED_MESSAGE,
      publishable: false,
    };
  }

  return {
    mode: "TEMPLATE",
    title: `${business} update`,
    body: `${voicePrefix(input)}${business} update${city ? ` for ${city}` : ""}. Edit this draft before asking an owner to approve it.`,
    message: MARKETING_AI_DISCONNECTED_MESSAGE,
    publishable: false,
  };
}

export type WeeklyPlanItem = {
  contentId: string;
  title: string;
  contentType: string;
  status: string;
  plannedFor: Date;
  channelIntent: string;
};

export function weeklyContentPlan(
  contents: Array<{
    id: string;
    title: string;
    contentType: string;
    status: string;
    plannedFor: Date | null;
    channelIntent: string;
  }>,
  weekStart: Date,
  weekEnd: Date,
): WeeklyPlanItem[] {
  return contents
    .filter((row) => row.plannedFor && row.plannedFor >= weekStart && row.plannedFor < weekEnd)
    .map((row) => ({
      contentId: row.id,
      title: row.title,
      contentType: row.contentType,
      status: row.status,
      plannedFor: row.plannedFor as Date,
      channelIntent: row.channelIntent,
    }))
    .sort((a, b) => a.plannedFor.getTime() - b.plannedFor.getTime());
}
