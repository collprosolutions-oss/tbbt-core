import { suggestedResponseText } from "@/lib/reviews";
import { AI_NOT_CONNECTED_MESSAGE, type StructuredAiOutput } from "@/lib/ai/types";

export type ReviewSentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNKNOWN";

export function describeReviewSentiment(body: string): {
  sentiment: ReviewSentiment;
  note: string;
} {
  const text = body.toLowerCase();
  if (!text.trim()) {
    return { sentiment: "UNKNOWN", note: "No review text is on file, so sentiment cannot be described." };
  }
  const negative = /(terrible|awful|rude|late|never again|worst|scam|unprofessional)/.test(text);
  const positive = /(great|excellent|amazing|professional|on time|recommend|thankful|love)/.test(text);
  if (negative && !positive) {
    return {
      sentiment: "NEGATIVE",
      note: "Described from the recorded review text only. This does not gate who receives a review request.",
    };
  }
  if (positive && !negative) {
    return {
      sentiment: "POSITIVE",
      note: "Described from the recorded review text only. This does not gate who receives a review request.",
    };
  }
  return {
    sentiment: "NEUTRAL",
    note: "The recorded review does not clearly lean positive or negative. Requests are never gated by sentiment.",
  };
}

export function draftReviewResponseFromRecord(input: {
  reviewerName?: string | null;
  body: string;
}): StructuredAiOutput {
  const sentiment = describeReviewSentiment(input.body);
  const who = input.reviewerName?.trim() ? `${input.reviewerName.trim()}, ` : "";
  const template = suggestedResponseText();
  return {
    text:
      sentiment.sentiment === "NEGATIVE"
        ? `${who}thank you for telling us. We recorded your feedback and will review the job record with the owner before any public reply.`
        : `${who}${template}`,
    stance: "RECOMMENDATION",
    citedFactKeys: ["recorded-review"],
    notes: `${AI_NOT_CONNECTED_MESSAGE} ${sentiment.note}`,
  };
}
