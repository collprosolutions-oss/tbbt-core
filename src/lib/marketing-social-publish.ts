/**
 * OWNER Facebook Page publish for one connected social destination.
 *
 * Claims a MarketingSocialPublishAttempt before the provider is called.
 * MarketingContent.status stays APPROVED — this never writes PUBLISHED
 * onto the content row. FAILED attempts keep that label and are shown
 * without calling them PUBLISHED. A DRAFT or merely planned day never
 * reaches the provider. Instagram and Google stay disconnected.
 *
 * Preview shares Production and skips migrate. Missing destination or
 * attempt tables fail closed. This file never runs request-time DDL.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import {
  OWNER_SOCIAL_PUBLISH_MESSAGE,
  PHOTO_PERMISSION_REVOKED_MESSAGE,
  SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE,
  SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
  SOCIAL_PUBLISH_ATTEMPT_FAILED,
  SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
  SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE,
  SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_NOT_IMPLEMENTED_MESSAGE,
  SOCIAL_PUBLISH_EMPTY_MESSAGE,
  SOCIAL_PUBLISH_FAILED_MESSAGE,
  SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
  SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE,
  SOCIAL_PUBLISH_PACKAGE_NOT_FOUND_MESSAGE,
  SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_FOUND_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_POSTED,
  SOCIAL_PUBLISH_RESOLVE_POSTED_MESSAGE,
  SOCIAL_PUBLISH_SCHEMA_UNAVAILABLE_MESSAGE,
  SOCIAL_PUBLISH_SNAPSHOT_REQUIRED_MESSAGE,
  SOCIAL_PUBLISH_STALE_MESSAGE,
  SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
  canResolveSocialPublishAttempt,
  composeSocialPublishMessage,
  isDisconnectedSocialPublishDestination,
  isImplementedSocialPublishDestination,
  isSocialPublishUnconfirmed,
  sanitizeSocialPublishProviderError,
  socialPublishAttemptLiveKey,
  studioPhotosEligible,
} from "@/lib/marketing";
import { MarketingError } from "@/lib/marketing-ops";
import { getSocialPublishingProvider } from "@/lib/social-publishing/provider";
import type { SocialPublishingProvider } from "@/lib/social-publishing/types";

type Db = PrismaClient | Prisma.TransactionClient;

const SOCIAL_PUBLISH_SCHEMA_NAME =
  /MarketingSocialDestination|marketingSocialDestination|MarketingSocialPublishAttempt|marketingSocialPublishAttempt/;
const OTHER_DB_ERROR_CODES = new Set(["P2002", "P2003", "P2014", "P2025"]);

export type MarketingSocialPublishDeps = {
  /** Test hook. Fake or disconnected adapter only. Never a live post. */
  provider?: SocialPublishingProvider;
  /** Test hook. Runs after the attempt is claimed and before the provider. */
  beforeProvider?: () => Promise<void>;
  /** Test hook. Runs after the in-flight pre-check and before the claim create. */
  beforeClaimCreate?: () => Promise<void>;
  /** Test hook. Omits liveKey so the unique guard can be proven. */
  omitLiveKey?: boolean;
};

export type MarketingSocialPublishResult = {
  contentId: string;
  destination: string;
  attemptId: string;
  status: "CLAIMED" | "PUBLISHED" | "FAILED";
  published: boolean;
  posted: boolean;
  unconfirmed: boolean;
  failureLabel: string | null;
  providerPostId: string | null;
  message: string;
};

export type ResolveMarketingSocialPublishInput = {
  attemptId: string;
  resolution: string;
};

export type ResolveMarketingSocialPublishResult = {
  attemptId: string;
  status: "PUBLISHED" | "FAILED";
  published: boolean;
  message: string;
};

function prismaErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: string }).code)
    : "";
}

function prismaErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function prismaErrorMeta(error: unknown) {
  if (!error || typeof error !== "object" || !("meta" in error)) return "";
  try {
    return JSON.stringify((error as { meta?: unknown }).meta ?? "");
  } catch {
    return "";
  }
}

export function missingMarketingSocialPublishSchema(error: unknown) {
  const code = prismaErrorCode(error);
  if (OTHER_DB_ERROR_CODES.has(code)) return false;
  const haystack = `${prismaErrorMessage(error)} ${prismaErrorMeta(error)}`;
  if (!SOCIAL_PUBLISH_SCHEMA_NAME.test(haystack)) return false;
  if (code === "P2021" || code === "P2022") return true;
  return (code === "" || code === "P2010") && /does not exist/i.test(haystack);
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function parseExpectedUpdatedAt(raw: string | Date | undefined): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function requireOwnerSocialPublish(access: BusinessAccess) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingError(OWNER_SOCIAL_PUBLISH_MESSAGE);
  }
  requireBusinessRole(access, "OWNER");
}

function safeProviderError(detail?: string | null, accessToken?: string | null) {
  return sanitizeSocialPublishProviderError(detail, accessToken) || null;
}

function safeFailureLabel(detail?: string | null, accessToken?: string | null) {
  const sanitized = sanitizeSocialPublishProviderError(detail, accessToken);
  const composed = sanitized ? `${SOCIAL_PUBLISH_FAILED_MESSAGE} ${sanitized}` : SOCIAL_PUBLISH_FAILED_MESSAGE;
  return sanitizeSocialPublishProviderError(composed, accessToken) || SOCIAL_PUBLISH_FAILED_MESSAGE;
}

function isUnknownProviderResult(result: {
  status?: string;
  outcome?: string;
}) {
  return result.status === "UNKNOWN" || result.outcome === "unknown";
}

export async function loadMarketingSocialDestinations(db: Db, businessId: string) {
  try {
    return await db.marketingSocialDestination.findMany({
      where: { businessId },
      select: { destination: true, pageId: true },
    });
  } catch (error) {
    if (missingMarketingSocialPublishSchema(error)) return [];
    throw error;
  }
}

export async function loadMarketingSocialPublishAttempts(db: Db, businessId: string) {
  try {
    return await db.marketingSocialPublishAttempt.findMany({
      where: { businessId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        contentId: true,
        destination: true,
        status: true,
        failureLabel: true,
        claimedAt: true,
        providerPostId: true,
        publishedAt: true,
        createdAt: true,
      },
    });
  } catch (error) {
    if (missingMarketingSocialPublishSchema(error)) return [];
    throw error;
  }
}

export function latestSocialPublishAttempt<
  T extends { contentId: string; destination: string; createdAt: Date },
>(attempts: readonly T[], contentId: string, destination: string) {
  return attempts.find((row) => row.contentId === contentId && row.destination === destination) ?? null;
}

async function recordAttemptResult(
  db: Db,
  attempt: { id: string; businessId: string; claimedAt: Date },
  result: {
    status: "PUBLISHED" | "FAILED";
    providerPostId?: string | null;
    providerError?: string | null;
    failureLabel?: string;
    accessToken?: string | null;
  },
) {
  const published = result.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED;
  const updated = await db.marketingSocialPublishAttempt.updateMany({
    where: {
      id: attempt.id,
      businessId: attempt.businessId,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      claimedAt: attempt.claimedAt,
    },
    data: {
      status: result.status,
      providerPostId: result.providerPostId ?? null,
      providerError: published ? null : safeProviderError(result.providerError, result.accessToken),
      failureLabel: published
        ? ""
        : sanitizeSocialPublishProviderError(
            result.failureLabel ?? safeFailureLabel(result.providerError, result.accessToken),
            result.accessToken,
          ) || SOCIAL_PUBLISH_FAILED_MESSAGE,
      publishedAt: published ? new Date() : null,
      liveKey: published ? undefined : null,
    },
  });
  return updated.count === 1;
}

async function recordUnknownOutcome(
  db: Db,
  attempt: { id: string; businessId: string; claimedAt: Date },
  result: { providerError?: string | null; accessToken?: string | null },
) {
  const updated = await db.marketingSocialPublishAttempt.updateMany({
    where: {
      id: attempt.id,
      businessId: attempt.businessId,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      claimedAt: attempt.claimedAt,
    },
    data: {
      providerError: safeProviderError(result.providerError, result.accessToken),
      failureLabel: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
    },
  });
  return updated.count === 1;
}

function unknownPublishResult(claimed: {
  contentId: string;
  destination: string;
  id: string;
}): MarketingSocialPublishResult {
  return {
    contentId: claimed.contentId,
    destination: claimed.destination,
    attemptId: claimed.id,
    status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
    published: false,
    posted: false,
    unconfirmed: true,
    failureLabel: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
    providerPostId: null,
    message: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
  };
}

export type PublishMarketingContentToSocialInput = {
  contentId: string;
  destination: string;
  expectedUpdatedAt: string | Date;
};

export async function publishMarketingContentToSocial(
  db: Db,
  access: BusinessAccess,
  input: PublishMarketingContentToSocialInput,
  deps?: MarketingSocialPublishDeps,
): Promise<MarketingSocialPublishResult> {
  requireOwnerSocialPublish(access);

  const destination = input.destination.trim();
  if (isDisconnectedSocialPublishDestination(destination) || !isImplementedSocialPublishDestination(destination)) {
    throw new MarketingError(
      isDisconnectedSocialPublishDestination(destination)
        ? SOCIAL_PUBLISH_DESTINATION_NOT_IMPLEMENTED_MESSAGE
        : SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE,
    );
  }

  const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expectedUpdatedAt) {
    throw new MarketingError(SOCIAL_PUBLISH_SNAPSHOT_REQUIRED_MESSAGE);
  }

  let claimed: {
    id: string;
    businessId: string;
    contentId: string;
    destination: string;
    status: string;
    claimedAt: Date;
    destinationPageId: string;
    accessToken: string;
    message: string;
  };

  try {
    claimed = await claimSocialPublishAttempt(
      db,
      access,
      {
        contentId: input.contentId,
        destination,
        expectedUpdatedAt,
      },
      deps,
    );
  } catch (error) {
    if (missingMarketingSocialPublishSchema(error)) {
      throw new MarketingError(SOCIAL_PUBLISH_SCHEMA_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }

  if (deps?.beforeProvider) await deps.beforeProvider();

  const provider = deps?.provider ?? getSocialPublishingProvider();
  let providerResult: {
    ok: boolean;
    status: "PUBLISHED" | "FAILED" | "UNKNOWN";
    outcome?: "rejected" | "unknown";
    providerPostId?: string;
    error?: string;
  };
  try {
    providerResult = await provider.publish({
      destination,
      pageId: claimed.destinationPageId,
      accessToken: claimed.accessToken,
      message: claimed.message,
    });
  } catch (error) {
    await recordUnknownOutcome(db, claimed, {
      providerError: error instanceof Error ? error.message : "provider threw",
      accessToken: claimed.accessToken,
    });
    return unknownPublishResult(claimed);
  }

  if (isUnknownProviderResult(providerResult)) {
    await recordUnknownOutcome(db, claimed, {
      providerError: providerResult.error ?? "provider outcome unknown",
      accessToken: claimed.accessToken,
    });
    return unknownPublishResult(claimed);
  }

  if (!providerResult.ok || providerResult.status !== SOCIAL_PUBLISH_ATTEMPT_PUBLISHED) {
    const failureLabel = safeFailureLabel(providerResult.error, claimed.accessToken);
    await recordAttemptResult(db, claimed, {
      status: SOCIAL_PUBLISH_ATTEMPT_FAILED,
      providerError: providerResult.error ?? "provider rejected",
      failureLabel,
      accessToken: claimed.accessToken,
    });
    return {
      contentId: claimed.contentId,
      destination: claimed.destination,
      attemptId: claimed.id,
      status: SOCIAL_PUBLISH_ATTEMPT_FAILED,
      published: false,
      posted: false,
      unconfirmed: false,
      failureLabel,
      providerPostId: null,
      message: failureLabel,
    };
  }

  const recorded = await recordAttemptResult(db, claimed, {
    status: SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
    providerPostId: providerResult.providerPostId ?? null,
    accessToken: claimed.accessToken,
  });
  if (!recorded) {
    return {
      contentId: claimed.contentId,
      destination: claimed.destination,
      attemptId: claimed.id,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      published: false,
      posted: false,
      unconfirmed: true,
      failureLabel: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
      providerPostId: null,
      message: SOCIAL_PUBLISH_UNCONFIRMED_MESSAGE,
    };
  }

  return {
    contentId: claimed.contentId,
    destination: claimed.destination,
    attemptId: claimed.id,
    status: SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
    published: true,
    posted: true,
    unconfirmed: false,
    failureLabel: null,
    providerPostId: providerResult.providerPostId ?? null,
    message: SOCIAL_PUBLISH_PUBLISHED_MESSAGE,
  };
}

export async function resolveMarketingSocialPublishAttempt(
  db: Db,
  access: BusinessAccess,
  input: ResolveMarketingSocialPublishInput,
): Promise<ResolveMarketingSocialPublishResult> {
  requireOwnerSocialPublish(access);

  const resolution = input.resolution.trim();
  if (resolution !== SOCIAL_PUBLISH_RESOLVE_NOT_POSTED && resolution !== SOCIAL_PUBLISH_RESOLVE_POSTED) {
    throw new MarketingError(SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE);
  }

  let attempt: {
    id: string;
    businessId: string;
    status: string;
    claimedAt: Date;
    failureLabel: string;
  } | null;
  try {
    attempt = await db.marketingSocialPublishAttempt.findFirst({
      where: { id: input.attemptId.trim(), ...access.scope },
      select: {
        id: true,
        businessId: true,
        status: true,
        claimedAt: true,
        failureLabel: true,
      },
    });
  } catch (error) {
    if (missingMarketingSocialPublishSchema(error)) {
      throw new MarketingError(SOCIAL_PUBLISH_SCHEMA_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
  if (!attempt) {
    throw new MarketingError(SOCIAL_PUBLISH_RESOLVE_NOT_FOUND_MESSAGE);
  }
  access.assertOwned(attempt);
  if (
    !canResolveSocialPublishAttempt({
      role: access.workspace.role,
      status: attempt.status,
      claimedAt: attempt.claimedAt,
      failureLabel: attempt.failureLabel,
    })
  ) {
    throw new MarketingError(SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE);
  }

  if (resolution === SOCIAL_PUBLISH_RESOLVE_POSTED) {
    const updated = await db.marketingSocialPublishAttempt.updateMany({
      where: {
        id: attempt.id,
        businessId: access.businessId,
        status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
      },
      data: {
        status: SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
        publishedAt: new Date(),
        failureLabel: "",
        providerError: null,
      },
    });
    if (updated.count !== 1) {
      throw new MarketingError(SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE);
    }
    return {
      attemptId: attempt.id,
      status: SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
      published: true,
      message: SOCIAL_PUBLISH_RESOLVE_POSTED_MESSAGE,
    };
  }

  const updated = await db.marketingSocialPublishAttempt.updateMany({
    where: {
      id: attempt.id,
      businessId: access.businessId,
      status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
    },
    data: {
      status: SOCIAL_PUBLISH_ATTEMPT_FAILED,
      liveKey: null,
      publishedAt: null,
      failureLabel: SOCIAL_PUBLISH_FAILED_MESSAGE,
      providerError: null,
    },
  });
  if (updated.count !== 1) {
    throw new MarketingError(SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE);
  }
  return {
    attemptId: attempt.id,
    status: SOCIAL_PUBLISH_ATTEMPT_FAILED,
    published: false,
    message: SOCIAL_PUBLISH_RESOLVE_NOT_POSTED_MESSAGE,
  };
}

async function claimSocialPublishAttempt(
  db: Db,
  access: BusinessAccess,
  input: {
    contentId: string;
    destination: typeof SOCIAL_PUBLISH_DESTINATION_FACEBOOK;
    expectedUpdatedAt: Date;
  },
  deps?: MarketingSocialPublishDeps,
) {
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
      include: {
        photos: {
          include: {
            jobPhoto: {
              select: { marketingPermissionStatus: true },
            },
          },
        },
      },
    }),
  );
  if (!content) {
    throw new MarketingError(SOCIAL_PUBLISH_PACKAGE_NOT_FOUND_MESSAGE);
  }
  if (content.status !== "APPROVED") {
    throw new MarketingError(SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE);
  }
  if (input.expectedUpdatedAt.getTime() !== content.updatedAt.getTime()) {
    throw new MarketingError(SOCIAL_PUBLISH_STALE_MESSAGE);
  }
  const photos = content.photos.map((row) => row.jobPhoto);
  if (photos.length === 0 || !studioPhotosEligible(photos)) {
    throw new MarketingError(PHOTO_PERMISSION_REVOKED_MESSAGE);
  }
  const message = composeSocialPublishMessage({
    caption: content.body,
    hashtags: content.hashtags,
  });
  if (!message) {
    throw new MarketingError(SOCIAL_PUBLISH_EMPTY_MESSAGE);
  }

  const destinationRow = await db.marketingSocialDestination.findFirst({
    where: {
      businessId: access.businessId,
      destination: input.destination,
    },
    select: { pageId: true, accessToken: true, destination: true },
  });
  if (!destinationRow?.pageId?.trim() || !destinationRow.accessToken) {
    throw new MarketingError(SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE);
  }

  const existing = await db.marketingSocialPublishAttempt.findFirst({
    where: {
      businessId: access.businessId,
      contentId: content.id,
      destination: input.destination,
      status: { in: [SOCIAL_PUBLISH_ATTEMPT_CLAIMED, SOCIAL_PUBLISH_ATTEMPT_PUBLISHED] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED) {
    throw new MarketingError(SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE);
  }
  if (existing?.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED) {
    throw new MarketingError(
      isSocialPublishUnconfirmed(existing)
        ? SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE
        : SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
    );
  }

  if (deps?.beforeClaimCreate) await deps.beforeClaimCreate();

  const claimedAt = new Date();
  try {
    const attempt = await db.marketingSocialPublishAttempt.create({
      data: {
        businessId: access.businessId,
        contentId: content.id,
        destination: input.destination,
        status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
        claimedAt,
        expectedContentUpdatedAt: content.updatedAt,
        destinationPageId: destinationRow.pageId.trim(),
        liveKey: deps?.omitLiveKey ? undefined : socialPublishAttemptLiveKey(content.id, input.destination),
        createdByMembershipId: access.workspace.membership.id,
      },
    });
    return {
      id: attempt.id,
      businessId: attempt.businessId,
      contentId: attempt.contentId,
      destination: attempt.destination,
      status: attempt.status,
      claimedAt: attempt.claimedAt,
      destinationPageId: destinationRow.pageId.trim(),
      accessToken: destinationRow.accessToken,
      message,
    };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const blocker = await db.marketingSocialPublishAttempt.findFirst({
      where: {
        businessId: access.businessId,
        contentId: content.id,
        destination: input.destination,
        status: { in: [SOCIAL_PUBLISH_ATTEMPT_CLAIMED, SOCIAL_PUBLISH_ATTEMPT_PUBLISHED] },
      },
    });
    if (blocker?.status === SOCIAL_PUBLISH_ATTEMPT_PUBLISHED) {
      throw new MarketingError(SOCIAL_PUBLISH_ALREADY_PUBLISHED_MESSAGE);
    }
    throw new MarketingError(
      blocker && isSocialPublishUnconfirmed(blocker)
        ? SOCIAL_PUBLISH_CONFIRM_FIRST_MESSAGE
        : SOCIAL_PUBLISH_IN_FLIGHT_MESSAGE,
    );
  }
}
