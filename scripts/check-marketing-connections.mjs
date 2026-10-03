/**
 * OWNER marketing destination connections.
 *
 * Fake provider responses only. No network to Meta or Google.
 * Proves tenant isolation, OWNER-only actions, OAuth state replay/expiry/
 * tamper, explicit destination selection, encrypted tokens, and that
 * connect never publishes.
 *
 * Run with:
 *   npm run test:marketing-connections
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const generateEarly = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit" });
if (generateEarly.status !== 0) {
  console.error("Failed to generate Prisma client for marketing connection checks.");
  process.exit(generateEarly.status ?? 1);
}

const { ForbiddenError } = await import("@/lib/authorization");
const { businessScope, assertBusinessRecord } = await import("@/lib/access-scope");
const { createSecureToken, hashToken } = await import("@/lib/auth-crypto");
const {
  ConnectionTokenCryptoError,
  decryptConnectionToken,
  encryptConnectionToken,
} = await import("@/lib/connection-token-crypto");
const {
  FACEBOOK_REQUIRED_SCOPES,
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  INSTAGRAM_REQUIRED_SCOPES,
  isFakeSocialOAuthAdapterEnabled,
  marketingDestinationAvailability,
  marketingTokenPurpose,
} = await import("@/lib/marketing-connections/config");
const { MarketingConnectionError } = await import("@/lib/marketing-connections/errors");
const { presentMarketingConnectionCards } = await import("@/lib/marketing-connections/presenter");
const {
  createFakeMarketingOAuthAdapter,
  createGoogleMarketingOAuthAdapter,
  createMetaMarketingOAuthAdapter,
  googleAuthorizeUrl,
  metaAuthorizeUrl,
} = await import("@/lib/marketing-connections/providers");
const {
  checkMarketingConnectionStatus,
  completeMarketingConnectionCallback,
  confirmMarketingConnectionSelection,
  disconnectMarketingConnection,
  loadMarketingConnectionCards,
  reconnectMarketingConnection,
  resolveConnectedPublishToken,
  startMarketingConnection,
} = await import("@/lib/marketing-connections/service");
const { getSocialPublishingProviderForDestination } = await import("@/lib/social-publishing/provider");
const {
  createInstagramSocialPublishingProvider,
  instagramMediaContainerUrl,
  instagramMediaPublishUrl,
} = await import("@/lib/social-publishing/instagram");
const {
  advanceMarketingContentStatus,
  createMarketingContent,
  grantJobPhotoMarketingPermission,
} = await import("@/lib/marketing-ops");
const { MarketingError } = await import("@/lib/marketing-ops");
const { publishMarketingContentToSocial } = await import("@/lib/marketing-social-publish");
const { createFakeSocialPublishingProvider } = await import("@/lib/social-publishing/fake");
const { SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE } = await import("@/lib/marketing");
const { withDisposableTestDatabase } = await import("./disposable-test-database.mjs");

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PAGE_TOKEN = "page-token-MUST-NOT-LEAK-918273";
const USER_TOKEN = "user-token-MUST-NOT-LEAK-445566";
const REFRESH_TOKEN = "refresh-token-MUST-NOT-LEAK-778899";

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

async function expectError(label, run, predicate) {
  try {
    await run();
    check(label, false);
  } catch (error) {
    check(label, predicate(error));
  }
}

function makeAccess(businessId, role, membershipId, userId) {
  return {
    businessId,
    workspace: { role, membership: { id: membershipId }, user: { id: userId } },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

function candidate(destination, externalId, displayName) {
  return {
    externalId,
    displayName,
    accessToken: `${PAGE_TOKEN}-${destination}`,
    refreshToken: destination === "GOOGLE" ? REFRESH_TOKEN : USER_TOKEN,
    expiresAt: null,
    accountId: `acct-${destination}`,
  };
}

function scriptFor(destination, overrides = {}) {
  const scopes =
    destination === "GOOGLE"
      ? [GOOGLE_BUSINESS_MANAGE_SCOPE]
      : destination === "INSTAGRAM"
        ? [...INSTAGRAM_REQUIRED_SCOPES]
        : [...FACEBOOK_REQUIRED_SCOPES];
  return createFakeMarketingOAuthAdapter(destination, {
    grantedScopes: scopes,
    userAccessToken: USER_TOKEN,
    candidates: [candidate(destination, `ext-${destination}`, `Name ${destination}`)],
    ...overrides,
  });
}

console.log("\nCRYPTO — connection token envelopes");
process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = KEY;
const round = encryptConnectionToken("marketing-facebook", "biz-a", PAGE_TOKEN);
check(
  "Round trip decrypts for the same purpose and business",
  decryptConnectionToken("marketing-facebook", "biz-a", round) === PAGE_TOKEN && !round.includes(PAGE_TOKEN),
);
await expectError("Tampered ciphertext is rejected", async () => {
  decryptConnectionToken("marketing-facebook", "biz-a", `${round}x`);
}, (error) => error instanceof ConnectionTokenCryptoError && !String(error.message).includes(PAGE_TOKEN));
await expectError("Wrong business AAD is rejected", async () => {
  decryptConnectionToken("marketing-facebook", "biz-b", round);
}, (error) => error instanceof ConnectionTokenCryptoError);
await expectError("Wrong purpose is rejected", async () => {
  decryptConnectionToken("marketing-instagram", "biz-a", round);
}, (error) => error instanceof ConnectionTokenCryptoError);
const savedKey = process.env.CONNECTION_TOKEN_ENCRYPTION_KEY;
delete process.env.CONNECTION_TOKEN_ENCRYPTION_KEY;
await expectError("Missing key is rejected", async () => {
  encryptConnectionToken("marketing-facebook", "biz-a", PAGE_TOKEN);
}, (error) => error instanceof ConnectionTokenCryptoError && /CONNECTION_TOKEN_ENCRYPTION_KEY/.test(error.message));
process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = savedKey;

console.log("\nPRESENTER — destinations stay independent");
const cards = presentMarketingConnectionCards({
  owner: true,
  availability: {
    FACEBOOK: { available: true, message: "" },
    INSTAGRAM: { available: true, message: "" },
    GOOGLE: { available: true, message: "" },
  },
  summaries: [
    {
      destination: "FACEBOOK",
      connectionStatus: "CONNECTED",
      displayName: "Alpha Page",
      lastError: "",
      remoteRevokeNote: "",
      publishable: true,
      legacyPlaintext: false,
      hasRow: true,
    },
    {
      destination: "INSTAGRAM",
      connectionStatus: "NEEDS_RECONNECT",
      displayName: "",
      lastError: "Needs more permission: instagram_content_publish",
      remoteRevokeNote: "",
      publishable: false,
      legacyPlaintext: false,
      hasRow: true,
    },
    {
      destination: "GOOGLE",
      connectionStatus: "DISCONNECTED",
      displayName: "Old location",
      lastError: "",
      remoteRevokeNote: "Local tokens were wiped.",
      publishable: false,
      legacyPlaintext: false,
      hasRow: true,
    },
  ],
});
check(
  "Instagram and Google trouble does not mark Facebook disconnected",
  cards.find((card) => card.destination === "FACEBOOK")?.status === "CONNECTED" &&
    cards.find((card) => card.destination === "FACEBOOK")?.statusLabel === "Connected" &&
    cards.find((card) => card.destination === "INSTAGRAM")?.statusLabel === "Needs more permission" &&
    cards.find((card) => card.destination === "GOOGLE")?.status === "DISCONNECTED",
);
const unavailable = presentMarketingConnectionCards({
  owner: true,
  availability: {
    FACEBOOK: { available: false, message: "Not available: needs META_APP_ID, META_APP_SECRET, and META_OAUTH_REDIRECT_URI." },
    INSTAGRAM: { available: false, message: "Not available: needs META_APP_ID, META_APP_SECRET, and META_OAUTH_REDIRECT_URI." },
    GOOGLE: {
      available: false,
      message:
        "Not available: needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI. Google Business Profile API access approval is also required.",
    },
  },
  summaries: [],
});
check(
  "Missing credentials say Not available and hide buttons",
  unavailable.every((card) => card.statusLabel === "Not available" && !card.showConnect && !card.showReconnect) &&
    unavailable.find((card) => card.destination === "GOOGLE")?.detail.includes("GOOGLE_OAUTH_CLIENT_ID"),
);

console.log("\nCONFIG — fake adapter and authorize URLs");
const previousVercel = process.env.VERCEL_ENV;
const previousOauth = process.env.TBBT_SOCIAL_OAUTH_ADAPTER;
process.env.VERCEL_ENV = "production";
process.env.TBBT_SOCIAL_OAUTH_ADAPTER = "fake";
check("Fake OAuth adapter is refused in production", isFakeSocialOAuthAdapterEnabled() === false);
delete process.env.VERCEL_ENV;
process.env.TBBT_SOCIAL_OAUTH_ADAPTER = "fake";
check("Fake OAuth adapter is allowed outside production", isFakeSocialOAuthAdapterEnabled() === true);
if (previousVercel == null) delete process.env.VERCEL_ENV;
else process.env.VERCEL_ENV = previousVercel;
if (previousOauth == null) delete process.env.TBBT_SOCIAL_OAUTH_ADAPTER;
else process.env.TBBT_SOCIAL_OAUTH_ADAPTER = previousOauth;
delete process.env.META_APP_ID;
delete process.env.META_APP_SECRET;
delete process.env.META_OAUTH_REDIRECT_URI;
delete process.env.TBBT_SOCIAL_OAUTH_ADAPTER;
check(
  "Facebook names the missing Meta credentials",
  marketingDestinationAvailability("FACEBOOK").message ===
    "Not available: needs META_APP_ID, META_APP_SECRET, and META_OAUTH_REDIRECT_URI.",
);
const metaUrl = metaAuthorizeUrl({
  appId: "app",
  redirectUri: "https://example.test/api/marketing/connections/meta/callback",
  state: "state-1",
  scopes: FACEBOOK_REQUIRED_SCOPES,
});
check(
  "Meta authorize URL requests the Page permissions",
  metaUrl.startsWith("https://www.facebook.com/v26.0/dialog/oauth") &&
    metaUrl.includes("pages_show_list") &&
    metaUrl.includes("pages_manage_posts") &&
    metaUrl.includes("pages_read_engagement") &&
    metaUrl.includes("response_type=code"),
);
const googleUrl = googleAuthorizeUrl({
  clientId: "client",
  redirectUri: "https://example.test/api/marketing/connections/google/callback",
  state: "state-2",
});
check(
  "Google authorize URL is the offline consent flow",
  googleUrl.startsWith("https://accounts.google.com/o/oauth2/v2/auth") &&
    googleUrl.includes("access_type=offline") &&
    googleUrl.includes("prompt=consent") &&
    googleUrl.includes(encodeURIComponent(GOOGLE_BUSINESS_MANAGE_SCOPE)),
);
const igCalls = [];
const igProvider = createInstagramSocialPublishingProvider(async (url, init) => {
  igCalls.push({ url: String(url), body: String(init.body) });
  if (String(url).includes("/media_publish")) {
    return { ok: true, status: 200, async json() { return { id: "ig_media_fake_1" }; } };
  }
  return { ok: true, status: 200, async json() { return { id: "ig_container_fake_1" }; } };
});
const igResult = await igProvider.publish({
  destination: "INSTAGRAM",
  pageId: "178414000",
  accessToken: PAGE_TOKEN,
  message: "public caption",
  imageUrl: "https://example.test/public.jpg",
});
const igPrivate = await igProvider.publish({
  destination: "INSTAGRAM",
  pageId: "178414000",
  accessToken: PAGE_TOKEN,
  message: "private",
  imageUrl: "https://example.test/api/storage/private/secret",
});
check(
  "Official Instagram client uses fake Meta responses and a public image",
  igResult.ok === true &&
    igResult.status === "PUBLISHED" &&
    igResult.providerPostId === "ig_media_fake_1" &&
    igCalls.length === 2 &&
    igCalls[0].url === instagramMediaContainerUrl("178414000") &&
    igCalls[1].url === instagramMediaPublishUrl("178414000") &&
    igCalls[0].body.includes("image_url=https%3A%2F%2Fexample.test%2Fpublic.jpg") &&
    !igCalls[0].body.includes("private") &&
    !igResult.error,
);
check(
  "Instagram client refuses a private storage URL without fetching",
  igPrivate.ok === false &&
    igPrivate.status === "FAILED" &&
    igCalls.length === 2 &&
    !igPrivate.error.includes(PAGE_TOKEN),
);
const googleProvider = getSocialPublishingProviderForDestination("GOOGLE");
const googleResult = await googleProvider.publish({
  destination: "GOOGLE",
  pageId: "1",
  accessToken: PAGE_TOKEN,
  message: "nope",
});
check(
  "Google local-post provider is implemented and refuses an unbound location",
  googleProvider.connected === true &&
    googleResult.ok === false &&
    googleResult.status === "FAILED" &&
    /bound|STANDARD Google local post|different destination/i.test(googleResult.error ?? "") &&
    !googleResult.error.includes(PAGE_TOKEN),
);

console.log("\nFIXTURE — live clients parse fake HTTP and do not use the network");
const metaCalls = [];
const metaFetch = async (url) => {
  metaCalls.push(String(url).split("?")[0]);
  const href = String(url);
  if (href.includes("/oauth/access_token") && href.includes("code=")) {
    return { ok: true, json: async () => ({ access_token: "short-user", expires_in: 100 }) };
  }
  if (href.includes("grant_type=fb_exchange_token")) {
    return { ok: true, json: async () => ({ access_token: "long-user", expires_in: 1000 }) };
  }
  if (href.includes("/debug_token")) {
    return { ok: true, json: async () => ({ data: { scopes: [...FACEBOOK_REQUIRED_SCOPES] } }) };
  }
  if (href.includes("/me/accounts")) {
    return {
      ok: true,
      json: async () => ({ data: [{ id: "page-1", name: "Fixture Page", access_token: "page-fixture" }] }),
    };
  }
  throw new Error(`unexpected Meta URL ${href.split("?")[0]}`);
};
const metaExchanged = await createMetaMarketingOAuthAdapter({
  destination: "FACEBOOK",
  appId: "app",
  appSecret: "secret",
  fetchImpl: metaFetch,
}).exchangeCode({ code: "fixture-code", redirectUri: "https://example.test/cb" });
check(
  "Meta client exchanges a code and lists Pages from the fixture",
  metaExchanged.candidates.length === 1 &&
    metaExchanged.candidates[0].externalId === "page-1" &&
    metaExchanged.grantedScopes.includes("pages_manage_posts") &&
    metaCalls.every((call) => call.startsWith("https://graph.facebook.com/")),
);
const googleCalls = [];
const googleFetch = async (url, init) => {
  googleCalls.push(`${init?.method ?? "GET"} ${String(url).split("?")[0]}`);
  const href = String(url);
  if (href === "https://oauth2.googleapis.com/token") {
    return {
      ok: true,
      json: async () => ({
        access_token: "ya29.fixture",
        refresh_token: "refresh-fixture",
        expires_in: 3600,
        scope: GOOGLE_BUSINESS_MANAGE_SCOPE,
      }),
    };
  }
  if (href === "https://mybusinessaccountmanagement.googleapis.com/v1/accounts") {
    return { ok: true, json: async () => ({ accounts: [{ name: "accounts/9" }] }) };
  }
  if (href.includes("/locations")) {
    return { ok: true, json: async () => ({ locations: [{ name: "locations/4", title: "Fixture Shop" }] }) };
  }
  throw new Error(`unexpected Google URL ${href.split("?")[0]}`);
};
const googleExchanged = await createGoogleMarketingOAuthAdapter({
  clientId: "client",
  clientSecret: "secret",
  fetchImpl: googleFetch,
}).exchangeCode({ code: "fixture-code", redirectUri: "https://example.test/cb" });
check(
  "Google client lists a location from the fixture",
  googleExchanged.candidates[0]?.externalId === "accounts/9/locations/4" &&
    googleExchanged.candidates[0]?.displayName === "Fixture Shop" &&
    googleCalls.some((call) => call.includes("https://oauth2.googleapis.com/token")),
);

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}

await withDisposableTestDatabase({ databaseUrl: baseUrl, namePrefix: "tbbt_mkt_conn" }, async ({ prisma }) => {
  process.env.CONNECTION_TOKEN_ENCRYPTION_KEY = KEY;
  delete process.env.TBBT_SOCIAL_OAUTH_ADAPTER;
  delete process.env.VERCEL_ENV;

  const businessA = await prisma.business.create({
    data: { name: "Alpha Connect", slug: `alpha-conn-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Connect", slug: `beta-conn-${randomUUID().slice(0, 8)}`, tradeCode: "HANDYMAN" },
  });
  const ownerUser = await prisma.user.create({
    data: { name: "Olivia Owner", email: `owner-conn-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: "Amir Admin", email: `admin-conn-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: "Mia Member", email: `member-conn-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const betaUser = await prisma.user.create({
    data: { name: "Bea Owner", email: `beta-conn-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const ownerMem = await prisma.membership.create({
    data: { userId: ownerUser.id, businessId: businessA.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { userId: adminUser.id, businessId: businessA.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { userId: memberUser.id, businessId: businessA.id, role: "MEMBER" },
  });
  const betaMem = await prisma.membership.create({
    data: { userId: betaUser.id, businessId: businessB.id, role: "OWNER" },
  });
  const ownerA = makeAccess(businessA.id, "OWNER", ownerMem.id, ownerUser.id);
  const adminA = makeAccess(businessA.id, "ADMIN", adminMem.id, adminUser.id);
  const memberA = makeAccess(businessA.id, "MEMBER", memberMem.id, memberUser.id);
  const ownerB = makeAccess(businessB.id, "OWNER", betaMem.id, betaUser.id);

  async function attemptCount(businessId) {
    return prisma.marketingSocialPublishAttempt.count({ where: { businessId } });
  }

  for (const [label, access] of [
    ["ADMIN", adminA],
    ["MEMBER", memberA],
  ]) {
    await expectError(`${label} cannot start a connection`, () => startMarketingConnection(prisma, access, "FACEBOOK", { adapter: scriptFor("FACEBOOK") }), (error) => error instanceof ForbiddenError);
    await expectError(`${label} cannot reconnect`, () => reconnectMarketingConnection(prisma, access, "FACEBOOK", { adapter: scriptFor("FACEBOOK") }), (error) => error instanceof ForbiddenError);
    await expectError(`${label} cannot confirm`, () => confirmMarketingConnectionSelection(prisma, access, { selectionToken: "x", externalId: "y" }), (error) => error instanceof ForbiddenError);
    await expectError(`${label} cannot check status`, () => checkMarketingConnectionStatus(prisma, access, "FACEBOOK"), (error) => error instanceof ForbiddenError);
    await expectError(`${label} cannot disconnect`, () => disconnectMarketingConnection(prisma, access, "FACEBOOK"), (error) => error instanceof ForbiddenError);
  }

  const logs = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const method of Object.keys(original)) {
    console[method] = (...args) => {
      logs.push(args.map((part) => String(part)).join(" "));
      original[method](...args);
    };
  }

  async function connectExplicit(access, destination, externalId = `ext-${destination}`) {
    const before = await attemptCount(access.businessId);
    const adapter = scriptFor(destination, {
      candidates: [candidate(destination, externalId, `Name ${destination}`)],
    });
    const started = await startMarketingConnection(prisma, access, destination, { adapter });
    check(`${destination} authorize URL stays on the fake host`, started.authorizeUrl.startsWith("https://oauth.fake.test/"));
    const selected = await completeMarketingConnectionCallback(
      prisma,
      {
        destinationGroup: destination === "GOOGLE" ? "GOOGLE" : "META",
        code: `code-${destination}`,
        state: started.stateToken,
      },
      { adapter },
    );
    const midCount = await prisma.marketingSocialDestination.count({
      where: { businessId: access.businessId, destination, connectionStatus: "CONNECTED" },
    });
    check(`${destination} callback does not connect before an explicit confirm`, selected.kind === "selection" && midCount === 0);
    await expectError(`${destination} rejects an id that was not returned`, () =>
      confirmMarketingConnectionSelection(
        prisma,
        access,
        { selectionToken: selected.selectionToken, externalId: "not-in-the-list" },
        { adapter },
      ),
    (error) => error instanceof MarketingConnectionError && /not in the list/.test(error.message));
    const restarted = await startMarketingConnection(prisma, access, destination, { adapter });
    const selectedAgain = await completeMarketingConnectionCallback(
      prisma,
      {
        destinationGroup: destination === "GOOGLE" ? "GOOGLE" : "META",
        code: `code-${destination}-2`,
        state: restarted.stateToken,
      },
      { adapter },
    );
    const confirmed = await confirmMarketingConnectionSelection(
      prisma,
      access,
      { selectionToken: selectedAgain.selectionToken, externalId },
      { adapter },
    );
    const after = await attemptCount(access.businessId);
    const row = await prisma.marketingSocialDestination.findFirst({
      where: { businessId: access.businessId, destination },
    });
    const token = `${PAGE_TOKEN}-${destination}`;
    const raw = JSON.stringify(row);
    check(
      `${destination} stores ciphertext only and publishes nothing`,
      confirmed.status === "CONNECTED" &&
        after === before &&
        row.accessToken === "" &&
        row.connectionStatus === "CONNECTED" &&
        !raw.includes(token) &&
        !raw.includes(USER_TOKEN) &&
        !raw.includes(REFRESH_TOKEN) &&
        decryptConnectionToken(marketingTokenPurpose(destination), access.businessId, row.accessTokenCiphertext) === token,
    );
    return { adapter, row };
  }

  console.log("\nFLOW — explicit connect does not publish");
  await connectExplicit(ownerA, "FACEBOOK", "ext-FACEBOOK");
  await connectExplicit(ownerA, "INSTAGRAM", "ext-INSTAGRAM");
  await connectExplicit(ownerA, "GOOGLE", "ext-GOOGLE");
  const loaded = await loadMarketingConnectionCards(prisma, businessA.id, true);
  check(
    "Connected destinations stay independent",
    loaded.find((card) => card.destination === "FACEBOOK")?.status === "CONNECTED" &&
      loaded.find((card) => card.destination === "INSTAGRAM")?.status === "CONNECTED" &&
      loaded.find((card) => card.destination === "GOOGLE")?.status === "CONNECTED" &&
      loaded.find((card) => card.destination === "INSTAGRAM")?.publishAvailable === true &&
      loaded.find((card) => card.destination === "GOOGLE")?.publishAvailable === true &&
      !JSON.stringify(loaded).includes(PAGE_TOKEN),
  );

  console.log("\nFLOW — replay, expiry, tamper, and cross-tenant state");
  const replayAdapter = scriptFor("FACEBOOK");
  await prisma.marketingSocialDestination.deleteMany({ where: { businessId: businessA.id, destination: "FACEBOOK" } });
  const replayStart = await startMarketingConnection(prisma, ownerA, "FACEBOOK", { adapter: replayAdapter });
  await completeMarketingConnectionCallback(
    prisma,
    { destinationGroup: "META", code: "once", state: replayStart.stateToken },
    { adapter: replayAdapter },
  );
  await expectError("OAuth state cannot be replayed", () =>
    completeMarketingConnectionCallback(
      prisma,
      { destinationGroup: "META", code: "twice", state: replayStart.stateToken },
      { adapter: replayAdapter },
    ),
  (error) => error instanceof MarketingConnectionError && /already used/.test(error.message));

  let clock = new Date("2026-10-03T12:00:00.000Z");
  const expiryAdapter = scriptFor("INSTAGRAM");
  await prisma.marketingSocialDestination.deleteMany({ where: { businessId: businessA.id, destination: "INSTAGRAM" } });
  const expiryStart = await startMarketingConnection(prisma, ownerA, "INSTAGRAM", {
    adapter: expiryAdapter,
    now: () => clock,
  });
  clock = new Date("2026-10-03T12:20:00.000Z");
  await expectError("Expired OAuth state is rejected", () =>
    completeMarketingConnectionCallback(
      prisma,
      { destinationGroup: "META", code: "late", state: expiryStart.stateToken },
      { adapter: expiryAdapter, now: () => clock },
    ),
  (error) => error instanceof MarketingConnectionError && /expired/.test(error.message));

  await expectError("Tampered OAuth state is rejected", () =>
    completeMarketingConnectionCallback(
      prisma,
      { destinationGroup: "META", code: "tamper", state: `${replayStart.stateToken}tamper` },
      { adapter: replayAdapter },
    ),
  (error) => error instanceof MarketingConnectionError && /not valid/.test(error.message));

  const crossAdapter = scriptFor("GOOGLE", {
    candidates: [candidate("GOOGLE", "ext-cross", "Cross Location")],
  });
  await prisma.marketingSocialDestination.deleteMany({ where: { businessId: businessA.id, destination: "GOOGLE" } });
  const crossStart = await startMarketingConnection(prisma, ownerA, "GOOGLE", { adapter: crossAdapter });
  const crossSelected = await completeMarketingConnectionCallback(
    prisma,
    { destinationGroup: "GOOGLE", code: "cross", state: crossStart.stateToken },
    { adapter: crossAdapter },
  );
  await expectError("Business B cannot confirm Business A's selection", () =>
    confirmMarketingConnectionSelection(prisma, ownerB, {
      selectionToken: crossSelected.selectionToken,
      externalId: "ext-cross",
    }),
  (error) => error instanceof MarketingConnectionError);
  const crossRow = await prisma.marketingSocialDestination.findFirst({
    where: { businessId: businessB.id, destination: "GOOGLE" },
  });
  check("Business B gained no Google destination", crossRow == null);
  await confirmMarketingConnectionSelection(
    prisma,
    ownerA,
    { selectionToken: crossSelected.selectionToken, externalId: "ext-cross" },
    { adapter: crossAdapter },
  );

  console.log("\nFLOW — permissions, refresh, reconnect, disconnect");
  await prisma.marketingSocialDestination.deleteMany({ where: { businessId: businessA.id, destination: "FACEBOOK" } });
  const missingAdapter = scriptFor("FACEBOOK", { grantedScopes: ["pages_show_list"] });
  const missingStart = await startMarketingConnection(prisma, ownerA, "FACEBOOK", { adapter: missingAdapter });
  const missing = await completeMarketingConnectionCallback(
    prisma,
    { destinationGroup: "META", code: "missing", state: missingStart.stateToken },
    { adapter: missingAdapter },
  );
  const missingRow = await prisma.marketingSocialDestination.findFirst({
    where: { businessId: businessA.id, destination: "FACEBOOK" },
  });
  check(
    "Missing Page permission is stored without a token",
    missing.kind === "needs_permission" &&
      missingRow.connectionStatus === "NEEDS_RECONNECT" &&
      missingRow.lastError.startsWith("Needs more permission") &&
      missingRow.accessToken === "" &&
      missingRow.accessTokenCiphertext == null &&
      (await resolveConnectedPublishToken(prisma, businessA.id, "FACEBOOK")) == null,
  );

  for (const destination of ["FACEBOOK", "INSTAGRAM", "GOOGLE"]) {
    await prisma.marketingSocialDestination.deleteMany({ where: { businessId: businessA.id, destination } });
    const connected = await connectExplicit(ownerA, destination, `refresh-${destination}`);
    await prisma.marketingSocialDestination.update({
      where: { id: connected.row.id },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    const refreshedToken = `refreshed-${destination}-token`;
    const refreshAdapter = scriptFor(destination, {
      refresh: {
        ok: true,
        accessToken: refreshedToken,
        refreshToken: `refresh-${destination}`,
        expiresAt: new Date(Date.now() + 3600_000),
        grantedScopes:
          destination === "GOOGLE"
            ? [GOOGLE_BUSINESS_MANAGE_SCOPE]
            : destination === "INSTAGRAM"
              ? [...INSTAGRAM_REQUIRED_SCOPES]
              : [...FACEBOOK_REQUIRED_SCOPES],
      },
    });
    const refreshed = await checkMarketingConnectionStatus(prisma, ownerA, destination, { adapter: refreshAdapter });
    const refreshedRow = await prisma.marketingSocialDestination.findFirst({ where: { id: connected.row.id } });
    check(
      `${destination} expired token refreshes without plaintext`,
      refreshed.status === "CONNECTED" &&
        refreshedRow.accessToken === "" &&
        !JSON.stringify(refreshedRow).includes(refreshedToken) &&
        decryptConnectionToken(marketingTokenPurpose(destination), businessA.id, refreshedRow.accessTokenCiphertext) === refreshedToken,
    );
    await prisma.marketingSocialDestination.update({
      where: { id: connected.row.id },
      data: { tokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    const failAdapter = scriptFor(destination, { refresh: { ok: false, error: "invalid_grant" } });
    const failedRefresh = await checkMarketingConnectionStatus(prisma, ownerA, destination, { adapter: failAdapter });
    const failedRow = await prisma.marketingSocialDestination.findFirst({ where: { id: connected.row.id } });
    check(
      `${destination} failed refresh becomes Needs reconnect`,
      failedRefresh.status === "NEEDS_RECONNECT" &&
        failedRow.connectionStatus === "NEEDS_RECONNECT" &&
        !failedRefresh.message.includes(refreshedToken),
    );
    check(
      `${destination} Needs reconnect cannot publish`,
      (await resolveConnectedPublishToken(prisma, businessA.id, destination)) == null,
    );
  }

  const reconnectAdapter = scriptFor("GOOGLE", {
    candidates: [candidate("GOOGLE", "ext-reconnected", "Reconnected Shop")],
  });
  const reconnectStart = await reconnectMarketingConnection(prisma, ownerA, "GOOGLE", { adapter: reconnectAdapter });
  const reconnectSelected = await completeMarketingConnectionCallback(
    prisma,
    { destinationGroup: "GOOGLE", code: "reconnect", state: reconnectStart.stateToken },
    { adapter: reconnectAdapter },
  );
  await confirmMarketingConnectionSelection(
    prisma,
    ownerA,
    { selectionToken: reconnectSelected.selectionToken, externalId: "ext-reconnected" },
    { adapter: reconnectAdapter },
  );
  const reconnected = await prisma.marketingSocialDestination.findFirst({
    where: { businessId: businessA.id, destination: "GOOGLE" },
  });
  check(
    "Reconnect replaces the Google destination",
    reconnected.connectionStatus === "CONNECTED" && reconnected.displayName === "Reconnected Shop" && reconnected.accessToken === "",
  );

  const facebookLeak = "refreshed-FACEBOOK-token";
  const disconnectAdapter = scriptFor("FACEBOOK", {
    revoke: { revoked: false, note: `Meta permission removal failed for ${facebookLeak}` },
  });
  await prisma.marketingSocialDestination.updateMany({
    where: { businessId: businessA.id, destination: "FACEBOOK" },
    data: { connectionStatus: "CONNECTED", tokenExpiresAt: new Date(Date.now() + 3600_000) },
  });
  const disconnected = await disconnectMarketingConnection(prisma, ownerA, "FACEBOOK", { adapter: disconnectAdapter });
  const disconnectedRow = await prisma.marketingSocialDestination.findFirst({
    where: { businessId: businessA.id, destination: "FACEBOOK" },
  });
  check(
    "Disconnect wipes ciphertext and does not echo the token",
    disconnectedRow.connectionStatus === "DISCONNECTED" &&
      disconnectedRow.accessToken === "" &&
      disconnectedRow.accessTokenCiphertext == null &&
      disconnectedRow.refreshTokenCiphertext == null &&
      !disconnected.message.includes(facebookLeak) &&
      !disconnectedRow.remoteRevokeNote.includes(facebookLeak) &&
      !disconnected.message.includes(PAGE_TOKEN) &&
      !disconnectedRow.remoteRevokeNote.includes(PAGE_TOKEN) &&
      (await resolveConnectedPublishToken(prisma, businessA.id, "FACEBOOK")) == null,
  );
  const otherCards = await loadMarketingConnectionCards(prisma, businessA.id, true);
  check(
    "Disconnecting Facebook leaves Instagram on its own Needs reconnect card",
    otherCards.find((card) => card.destination === "FACEBOOK")?.status === "DISCONNECTED" &&
      otherCards.find((card) => card.destination === "INSTAGRAM")?.status === "NEEDS_RECONNECT",
  );

  console.log("\nTENANT — A cannot operate on B");
  const secretName = "Beta Secret Location";
  await prisma.marketingSocialDestination.create({
    data: {
      businessId: businessB.id,
      destination: "GOOGLE",
      pageId: "beta-location",
      accessToken: "",
      accessTokenCiphertext: encryptConnectionToken("marketing-google", businessB.id, `${PAGE_TOKEN}-BETA`),
      connectionStatus: "CONNECTED",
      displayName: secretName,
      scopesGranted: GOOGLE_BUSINESS_MANAGE_SCOPE,
    },
  });
  const seenByA = await loadMarketingConnectionCards(prisma, businessA.id, true);
  check("A does not see B's destination name", !JSON.stringify(seenByA).includes(secretName));
  await expectError("A cannot disconnect B's destination", async () => {
    await disconnectMarketingConnection(prisma, ownerA, "GOOGLE", { adapter: scriptFor("GOOGLE") });
    const beta = await prisma.marketingSocialDestination.findFirst({
      where: { businessId: businessB.id, destination: "GOOGLE" },
    });
    if (beta.accessTokenCiphertext == null) throw new Error("wiped");
    throw new MarketingConnectionError("A disconnected A's own row, not B");
  }, (error) => error instanceof MarketingConnectionError && error.message.includes("not B"));
  const betaStill = await prisma.marketingSocialDestination.findFirst({
    where: { businessId: businessB.id, destination: "GOOGLE" },
  });
  check(
    "B's ciphertext is still present",
    Boolean(betaStill.accessTokenCiphertext) &&
      decryptConnectionToken("marketing-google", businessB.id, betaStill.accessTokenCiphertext) === `${PAGE_TOKEN}-BETA`,
  );

  console.log("\nLEGACY — plaintext Facebook row");
  await prisma.marketingSocialDestination.deleteMany({ where: { businessId: businessA.id, destination: "FACEBOOK" } });
  await prisma.marketingSocialDestination.create({
    data: {
      businessId: businessA.id,
      destination: "FACEBOOK",
      pageId: "111222333",
      accessToken: "fake-page-token",
    },
  });
  const legacyCards = await loadMarketingConnectionCards(prisma, businessA.id, true);
  const legacyResolved = await resolveConnectedPublishToken(prisma, businessA.id, "FACEBOOK");
  check(
    "Legacy plaintext is Needs reconnect and is not copied into the card",
    legacyCards.find((card) => card.destination === "FACEBOOK")?.statusLabel === "Needs reconnect" &&
      !JSON.stringify(legacyCards).includes("fake-page-token") &&
      legacyResolved?.accessToken === "fake-page-token",
  );
  let legacyInspects = 0;
  await checkMarketingConnectionStatus(prisma, ownerA, "FACEBOOK", {
    adapter: {
      ...scriptFor("FACEBOOK"),
      async inspectAccessToken() {
        legacyInspects += 1;
        return { ok: true, grantedScopes: [...FACEBOOK_REQUIRED_SCOPES] };
      },
    },
  });
  check("Legacy status check does not send the plaintext token", legacyInspects === 0);

  const customer = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Ada Homeowner" },
  });
  const job = await prisma.job.create({
    data: { businessId: businessA.id, customerId: customer.id, status: "COMPLETED", projectToken: randomUUID() },
  });
  const photo = await prisma.jobPhoto.create({
    data: {
      businessId: businessA.id,
      jobId: job.id,
      stage: "AFTER",
      url: "https://example.test/after.jpg",
      caption: "Ada",
    },
  });
  await grantJobPhotoMarketingPermission(prisma, ownerA, { photoId: photo.id });
  const draft = await createMarketingContent(prisma, adminA, {
    contentType: "COMPLETED_JOB",
    title: "Legacy publish",
    body: "Faucet repair completed in Reno.",
    channelIntent: "FACEBOOK",
    jobId: job.id,
    photoIds: [photo.id],
    hashtags: "Reno",
  });
  await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  const approved = await advanceMarketingContentStatus(prisma, ownerA, { contentId: draft.id });
  const publisher = createFakeSocialPublishingProvider();
  const published = await publishMarketingContentToSocial(
    prisma,
    ownerA,
    { contentId: approved.id, destination: "FACEBOOK", expectedUpdatedAt: approved.updatedAt },
    { provider: publisher },
  );
  check(
    "Legacy plaintext Facebook row can still publish through the existing click",
    published.published === true && publisher.published.length === 1 && publisher.published[0].accessToken === "fake-page-token",
  );
  await disconnectMarketingConnection(prisma, ownerA, "FACEBOOK", { adapter: scriptFor("FACEBOOK") });
  const blocked = createFakeSocialPublishingProvider();
  await expectError("Disconnect blocks a later Facebook publish", () =>
    publishMarketingContentToSocial(
      prisma,
      ownerA,
      { contentId: approved.id, destination: "FACEBOOK", expectedUpdatedAt: approved.updatedAt },
      { provider: blocked },
    ),
  (error) => error instanceof MarketingError && error.message === SOCIAL_PUBLISH_DESTINATION_DISCONNECTED_MESSAGE && blocked.callCount === 0);

  const adminRaw = createSecureToken();
  await prisma.marketingConnectionOAuthState.create({
    data: {
      businessId: businessA.id,
      membershipId: adminMem.id,
      destination: "FACEBOOK",
      purpose: "CONSENT",
      tokenHash: hashToken(adminRaw),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await expectError("Callback rejects a state bound to ADMIN", () =>
    completeMarketingConnectionCallback(
      prisma,
      { destinationGroup: "META", code: "admin", state: adminRaw },
      { adapter: scriptFor("FACEBOOK") },
    ),
  (error) => error instanceof MarketingConnectionError);

  for (const method of Object.keys(original)) console[method] = original[method];
  const leakHaystack = logs.join("\n");
  check(
    "Tokens were not written to console",
    !leakHaystack.includes(PAGE_TOKEN) && !leakHaystack.includes(USER_TOKEN) && !leakHaystack.includes(REFRESH_TOKEN) && !leakHaystack.includes(KEY),
  );
  check("Connect created no extra publish attempt beyond the explicit legacy publish", (await attemptCount(businessA.id)) === 1);
});

console.log(failed === 0 ? `\nAll marketing connection checks passed (${passed}).` : `\n${failed} marketing connection check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
