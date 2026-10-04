/**
 * OWNER Facebook Page, Instagram, or Google Business Profile local-post
 * publish for one connected social destination.
 *
 * Claims a MarketingSocialPublishAttempt before the provider is called.
 * MarketingContent.status stays APPROVED — this never writes PUBLISHED
 * onto the content row. FAILED attempts keep that label and are shown
 * without calling them PUBLISHED. A DRAFT or merely planned day never
 * reaches the provider. Instagram uses only an approved public marketing
 * image and never sends a private job or customer photo. Google posts a
 * STANDARD local post only and never claims ranking improvements.
 * Expired Google tokens refresh through the #347 connection refresh token
 * when one exists. Otherwise they are refused as reconnect needed before
 * any Google call. A 401, including a non-JSON body, marks NEEDS_RECONNECT
 * and is not retried.
 *
 * Preview shares Production and skips migrate. Missing destination or
 * attempt tables fail closed. This file never runs request-time DDL.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability, requireBusinessRole } from "@/lib/authorization";
import {
  PHOTO_PERMISSION_REVOKED_MESSAGE,
  GOOGLE_ACCOUNT_BINDING_MESSAGE,
  GOOGLE_LOCAL_POST_TOO_LONG_MESSAGE,
  SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
  SOCIAL_PUBLISH_ATTEMPT_FAILED,
  SOCIAL_PUBLISH_ATTEMPT_PUBLISHED,
  SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE,
  SOCIAL_PUBLISH_DESTINATION_FACEBOOK,
  SOCIAL_PUBLISH_DESTINATION_GOOGLE,
  SOCIAL_PUBLISH_DESTINATION_INSTAGRAM,
  SOCIAL_PUBLISH_DESTINATION_NOT_IMPLEMENTED_MESSAGE,
  SOCIAL_PUBLISH_NOT_APPROVED_MESSAGE,
  SOCIAL_PUBLISH_PACKAGE_NOT_FOUND_MESSAGE,
  SOCIAL_PUBLISH_PUBLIC_ASSET_REQUIRED_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED,
  SOCIAL_PUBLISH_RESOLVE_NOT_POSTED_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE,
  SOCIAL_PUBLISH_RESOLVE_POSTED,
  SOCIAL_PUBLISH_SNAPSHOT_REQUIRED_MESSAGE,
  SOCIAL_PUBLISH_STALE_MESSAGE,
  canResolveSocialPublishAttempt,
  composeSocialPublishMessage,
  isDisconnectedSocialPublishDestination,
  isImplementedSocialPublishDestination,
  isSocialPublishUnconfirmed,
  sanitizeSocialPublishProviderError,
  selectPublicMarketingAssetUrl,
  socialPublishAttemptLiveKey,
  socialPublishCopy,
  studioPhotosEligible,
  type ImplementedSocialPublishDestination,
} from "@/lib/marketing";
import { MarketingError } from "@/lib/marketing-ops";
import { getAppUrl } from "@/lib/mail";
import {
  markMarketingConnectionNeedsReconnect,
  resolveConnectedPublishToken,
  type MarketingConnectionDeps,
} from "@/lib/marketing-connections/service";
import {
  GOOGLE_LOCAL_POST_SUMMARY_MAX,
  GOOGLE_RECONNECT_NEEDED_MESSAGE,
  composeGoogleLocalPostPayload,
  isGoogleAccountBoundToLocation,
  parseGoogleLocationResource,
} from "@/lib/social-publishing/google";
import { getSocialPublishingProviderForDestination } from "@/lib/social-publishing/provider";
import type { GoogleLocalPostPayload, SocialPublishingProvider } from "@/lib/social-publishing/types";

type Db = PrismaClient | Prisma.TransactionClient;

const SOCIAL_PUBLISH_SCHEMA_NAME =
  /MarketingSocialDestination|marketingSocialDestination|MarketingSocialPublishAttempt|marketingSocialPublishAttempt/;
const OTHER_DB_ERROR_CODES = new Set(["P2002", "P2003", "P2014", "P2025"]);

export type MarketingSocialPublishDeps = {
  /** Test hook. Fake or disconnected adapter only. Never a live post. */
  provider?: SocialPublishingProvider;
  /** Test hook for #347 token refresh during claim. Never a live post. */
  connection?: MarketingConnectionDeps;
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

export type ResolveMarketingSocialPublishDeps = {
  /** Test hook. Runs after the unconfirmed pre-check and before the CAS update. */
  beforeResolveUpdate?: () => Promise<void>;
  /** Test hook. Omits status: CLAIMED so the compare-and-set guard can be proven. */
  omitResolveClaimedGuard?: boolean;
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

function requireOwnerSocialPublish(access: BusinessAccess, destination?: string) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_MARKETING);
  if (access.workspace.role !== "OWNER") {
    throw new MarketingError(socialPublishCopy(destination ?? SOCIAL_PUBLISH_DESTINATION_FACEBOOK).owner);
  }
  requireBusinessRole(access, "OWNER");
}

function safeProviderError(detail?: string | null, accessToken?: string | null) {
  return sanitizeSocialPublishProviderError(detail, accessToken) || null;
}

function safeFailureLabel(detail?: string | null, accessToken?: string | null, destination?: string) {
  const failed = socialPublishCopy(destination ?? SOCIAL_PUBLISH_DESTINATION_FACEBOOK).failed;
  const sanitized = sanitizeSocialPublishProviderError(detail, accessToken);
  const composed = sanitized ? `${failed} ${sanitized}` : failed;
  return sanitizeSocialPublishProviderError(composed, accessToken) || failed;
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
  attempt: { id: string; businessId: string; claimedAt: Date; destination?: string },
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
            result.failureLabel ?? safeFailureLabel(result.providerError, result.accessToken, attempt.destination),
            result.accessToken,
          ) || socialPublishCopy(attempt.destination ?? SOCIAL_PUBLISH_DESTINATION_FACEBOOK).failed,
      publishedAt: published ? new Date() : null,
      liveKey: published ? undefined : null,
    },
  });
  return updated.count === 1;
}

async function recordUnknownOutcome(
  db: Db,
  attempt: { id: string; businessId: string; claimedAt: Date; destination?: string },
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
      failureLabel: socialPublishCopy(attempt.destination ?? SOCIAL_PUBLISH_DESTINATION_FACEBOOK).unconfirmed,
    },
  });
  return updated.count === 1;
}

function unknownPublishResult(claimed: {
  contentId: string;
  destination: string;
  id: string;
}): MarketingSocialPublishResult {
  const unconfirmed = socialPublishCopy(claimed.destination).unconfirmed;
  return {
    contentId: claimed.contentId,
    destination: claimed.destination,
    attemptId: claimed.id,
    status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED,
    published: false,
    posted: false,
    unconfirmed: true,
    failureLabel: unconfirmed,
    providerPostId: null,
    message: unconfirmed,
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
  const destination = input.destination.trim();
  requireOwnerSocialPublish(access, destination);
  const copy = socialPublishCopy(destination);
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
    accountId: string;
    accessToken: string;
    message: string;
    imageUrl?: string;
    localPost: GoogleLocalPostPayload | null;
  };

  try {
    claimed = await claimSocialPublishAttempt(
      db,
      access,
      {
        contentId: input.contentId,
        destination: destination as ImplementedSocialPublishDestination,
        expectedUpdatedAt,
      },
      deps,
    );
  } catch (error) {
    if (missingMarketingSocialPublishSchema(error)) {
      throw new MarketingError(copy.schema);
    }
    throw error;
  }

  if (deps?.beforeProvider) await deps.beforeProvider();

  const provider = deps?.provider ?? getSocialPublishingProviderForDestination(destination);
  let providerResult: {
    ok: boolean;
    status: "PUBLISHED" | "FAILED" | "UNKNOWN";
    outcome?: "rejected" | "unknown";
    providerPostId?: string;
    error?: string;
  };
  try {
    providerResult = await provider.publish({
      destination: destination as ImplementedSocialPublishDestination,
      pageId: claimed.destinationPageId,
      accountId: claimed.accountId || undefined,
      accessToken: claimed.accessToken,
      message: claimed.message,
      imageUrl: claimed.imageUrl,
      localPost: claimed.localPost ?? undefined,
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
    const reconnectNeeded =
      destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE &&
      providerResult.error === GOOGLE_RECONNECT_NEEDED_MESSAGE;
    if (reconnectNeeded) {
      await markMarketingConnectionNeedsReconnect(
        db,
        access.businessId,
        destination,
        providerResult.error ?? GOOGLE_RECONNECT_NEEDED_MESSAGE,
      );
    }
    const failureLabel = safeFailureLabel(providerResult.error, claimed.accessToken, claimed.destination);
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
    return unknownPublishResult(claimed);
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
    message: copy.published,
  };
}

export async function resolveMarketingSocialPublishAttempt(
  db: Db,
  access: BusinessAccess,
  input: ResolveMarketingSocialPublishInput,
  deps?: ResolveMarketingSocialPublishDeps,
): Promise<ResolveMarketingSocialPublishResult> {
  requireOwnerSocialPublish(access);

  const resolution = input.resolution.trim();
  if (resolution !== SOCIAL_PUBLISH_RESOLVE_NOT_POSTED && resolution !== SOCIAL_PUBLISH_RESOLVE_POSTED) {
    throw new MarketingError(SOCIAL_PUBLISH_RESOLVE_NOT_READY_MESSAGE);
  }

  let attempt: {
    id: string;
    businessId: string;
    destination: string;
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
        destination: true,
        status: true,
        claimedAt: true,
        failureLabel: true,
      },
    });
  } catch (error) {
    if (missingMarketingSocialPublishSchema(error)) {
      throw new MarketingError(socialPublishCopy(SOCIAL_PUBLISH_DESTINATION_FACEBOOK).schema);
    }
    throw error;
  }
  if (!attempt) {
    throw new MarketingError(socialPublishCopy(SOCIAL_PUBLISH_DESTINATION_FACEBOOK).resolveNotFound);
  }
  const resolveCopy = socialPublishCopy(attempt.destination);
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

  if (deps?.beforeResolveUpdate) await deps.beforeResolveUpdate();

  const claimedWhere = deps?.omitResolveClaimedGuard
    ? { id: attempt.id, businessId: access.businessId }
    : { id: attempt.id, businessId: access.businessId, status: SOCIAL_PUBLISH_ATTEMPT_CLAIMED };

  if (resolution === SOCIAL_PUBLISH_RESOLVE_POSTED) {
    const updated = await db.marketingSocialPublishAttempt.updateMany({
      where: claimedWhere,
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
      message: resolveCopy.resolvePosted,
    };
  }

  const updated = await db.marketingSocialPublishAttempt.updateMany({
    where: claimedWhere,
    data: {
      status: SOCIAL_PUBLISH_ATTEMPT_FAILED,
      liveKey: null,
      publishedAt: null,
      failureLabel: resolveCopy.failed,
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
    destination: ImplementedSocialPublishDestination;
    expectedUpdatedAt: Date;
  },
  deps?: MarketingSocialPublishDeps,
) {
  const copy = socialPublishCopy(input.destination);
  const content = access.assertOwned(
    await db.marketingContent.findFirst({
      where: { id: input.contentId, ...access.scope },
      include: {
        photos: {
          include: {
            jobPhoto: {
              select: {
                marketingPermissionStatus: true,
                url: true,
                storedAsset: {
                  select: {
                    visibility: true,
                    status: true,
                    deletedAt: true,
                    category: true,
                    publicPath: true,
                  },
                },
              },
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
  const photos = content.photos.map((row) => ({
    marketingPermissionStatus: row.jobPhoto.marketingPermissionStatus,
    url: row.jobPhoto.url,
    visibility: row.jobPhoto.storedAsset?.visibility,
    status: row.jobPhoto.storedAsset?.status,
    deletedAt: row.jobPhoto.storedAsset?.deletedAt,
    category: row.jobPhoto.storedAsset?.category,
    publicPath: row.jobPhoto.storedAsset?.publicPath,
  }));
  if (photos.length === 0 || !studioPhotosEligible(photos)) {
    throw new MarketingError(PHOTO_PERMISSION_REVOKED_MESSAGE);
  }
  const message = composeSocialPublishMessage({
    caption: content.body,
    hashtags: content.hashtags,
  });
  if (!message) {
    throw new MarketingError(copy.empty);
  }

  let imageUrl: string | undefined;
  if (input.destination === SOCIAL_PUBLISH_DESTINATION_INSTAGRAM) {
    imageUrl = selectPublicMarketingAssetUrl(photos, getAppUrl()) ?? undefined;
    if (!imageUrl) {
      throw new MarketingError(SOCIAL_PUBLISH_PUBLIC_ASSET_REQUIRED_MESSAGE);
    }
  }

  const localPost =
    input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE
      ? composeGoogleLocalPostPayload({ summary: message })
      : null;
  if (input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE && !localPost) {
    throw new MarketingError(copy.empty);
  }
  if (input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE && message.length > GOOGLE_LOCAL_POST_SUMMARY_MAX) {
    throw new MarketingError(GOOGLE_LOCAL_POST_TOO_LONG_MESSAGE);
  }

  const destinationRow = await resolveConnectedPublishToken(
    db,
    access.businessId,
    input.destination,
    deps?.connection,
  );
  if (!destinationRow?.pageId?.trim() || !destinationRow.accessToken) {
    if (input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE) {
      const statusRow = await db.marketingSocialDestination.findFirst({
        where: { businessId: access.businessId, destination: input.destination },
        select: { connectionStatus: true, tokenExpiresAt: true },
      });
      const now = deps?.connection?.now?.() ?? new Date();
      const expired =
        statusRow?.connectionStatus === "EXPIRED" ||
        (statusRow?.connectionStatus === "NEEDS_RECONNECT" &&
          statusRow.tokenExpiresAt != null &&
          statusRow.tokenExpiresAt.getTime() <= now.getTime());
      if (expired) {
        throw new MarketingError(GOOGLE_RECONNECT_NEEDED_MESSAGE);
      }
    }
    throw new MarketingError(copy.disconnected);
  }
  if (input.destination === SOCIAL_PUBLISH_DESTINATION_GOOGLE) {
    const location = parseGoogleLocationResource(destinationRow.pageId);
    if (
      !location ||
      !isGoogleAccountBoundToLocation(destinationRow.externalAccountId, destinationRow.pageId)
    ) {
      throw new MarketingError(GOOGLE_ACCOUNT_BINDING_MESSAGE);
    }
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
    throw new MarketingError(copy.already);
  }
  if (existing?.status === SOCIAL_PUBLISH_ATTEMPT_CLAIMED) {
    throw new MarketingError(isSocialPublishUnconfirmed(existing) ? copy.confirmFirst : copy.inFlight);
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
      accountId: destinationRow.externalAccountId,
      accessToken: destinationRow.accessToken,
      message,
      imageUrl,
      localPost,
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
      throw new MarketingError(copy.already);
    }
    throw new MarketingError(blocker && isSocialPublishUnconfirmed(blocker) ? copy.confirmFirst : copy.inFlight);
  }
}
