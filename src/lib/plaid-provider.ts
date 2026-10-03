/**
 * Plaid Link + Transactions Sync adapter.
 *
 * Fake adapter is the disposable-test default. The real adapter talks to
 * Plaid over HTTPS once PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV are set.
 * Neither adapter moves money or fetches a verified cash balance.
 */
import { createHash, randomUUID } from "node:crypto";
import { PLAID_WEBHOOK_PATH } from "@/lib/plaid-webhook-path";

export type PlaidEnvironment = "sandbox" | "development" | "production";

export type PlaidLinkTokenResult = {
  linkToken: string;
  updateMode: boolean;
};

export type PlaidExchangeResult = {
  accessToken: string;
  itemId: string;
};

export type PlaidAccount = {
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
};

export type PlaidInstitution = {
  institutionId: string | null;
  institutionName: string;
};

export type PlaidSyncedTransaction = {
  transactionId: string;
  accountId: string;
  date: string;
  name: string;
  amount: number;
  pending: boolean;
};

export type PlaidSyncPage = {
  added: PlaidSyncedTransaction[];
  modified: PlaidSyncedTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
};

export type PlaidLoginRequiredError = Error & { code: "ITEM_LOGIN_REQUIRED" };

export interface PlaidProvider {
  readonly id: "fake" | "plaid";
  createLinkToken(input: {
    clientUserId: string;
    accessToken?: string;
    webhookUrl?: string;
  }): Promise<PlaidLinkTokenResult>;
  exchangePublicToken(publicToken: string): Promise<PlaidExchangeResult>;
  getItem(accessToken: string): Promise<PlaidInstitution>;
  getAccounts(accessToken: string): Promise<PlaidAccount[]>;
  transactionsSync(input: { accessToken: string; cursor: string }): Promise<PlaidSyncPage>;
  removeItem(accessToken: string): Promise<void>;
  restoreLogin(accessToken: string): Promise<void>;
}

export class PlaidProviderError extends Error {
  readonly code: string;
  constructor(message: string, code = "PLAID_ERROR") {
    super(message);
    this.name = "PlaidProviderError";
    this.code = code;
  }
}

export function isPlaidLoginRequired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  return code === "ITEM_LOGIN_REQUIRED";
}

type FakeAccount = PlaidAccount;
type FakeTxn = PlaidSyncedTransaction;

type FakeItem = {
  itemId: string;
  accessToken: string;
  publicToken: string;
  institutionId: string;
  institutionName: string;
  loginRequired: boolean;
  removed: boolean;
  accounts: FakeAccount[];
  posted: FakeTxn[];
  queuedAdded: FakeTxn[];
  queuedModified: FakeTxn[];
  queuedRemoved: string[];
  cursorSerial: number;
};

const fakeItems = new Map<string, FakeItem>();

function defaultFakeAccounts(): FakeAccount[] {
  return [
    {
      accountId: "fake-checking",
      name: "Plaid Checking",
      officialName: "Plaid Gold Standard 0% Interest Checking",
      mask: "0000",
      type: "depository",
      subtype: "checking",
    },
  ];
}

function tokenKey(accessToken: string) {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

export function resetFakePlaidProvider() {
  fakeItems.clear();
}

export function seedFakePlaidPostedTransactions(accessToken: string, rows: FakeTxn[]) {
  const item = [...fakeItems.values()].find((candidate) => candidate.accessToken === accessToken);
  if (!item) throw new PlaidProviderError("Unknown fake Plaid item.", "ITEM_NOT_FOUND");
  item.posted = rows.map((row) => ({ ...row }));
}

export function queueFakePlaidSync(accessToken: string, input: {
  added?: FakeTxn[];
  modified?: FakeTxn[];
  removed?: string[];
}) {
  const item = [...fakeItems.values()].find((candidate) => candidate.accessToken === accessToken);
  if (!item) throw new PlaidProviderError("Unknown fake Plaid item.", "ITEM_NOT_FOUND");
  item.queuedAdded.push(...(input.added ?? []));
  item.queuedModified.push(...(input.modified ?? []));
  item.queuedRemoved.push(...(input.removed ?? []));
}

export function fakePlaidResetLogin(accessToken: string) {
  const item = [...fakeItems.values()].find((candidate) => candidate.accessToken === accessToken);
  if (!item) throw new PlaidProviderError("Unknown fake Plaid item.", "ITEM_NOT_FOUND");
  item.loginRequired = true;
}

export function fakePlaidRestoreLogin(accessToken: string) {
  const item = [...fakeItems.values()].find((candidate) => candidate.accessToken === accessToken);
  if (!item) throw new PlaidProviderError("Unknown fake Plaid item.", "ITEM_NOT_FOUND");
  item.loginRequired = false;
}

export class FakePlaidProvider implements PlaidProvider {
  readonly id = "fake" as const;

  async createLinkToken(input: {
    clientUserId: string;
    accessToken?: string;
    webhookUrl?: string;
  }): Promise<PlaidLinkTokenResult> {
    const updateMode = Boolean(input.accessToken);
    return {
      linkToken: updateMode
        ? `link-sandbox-update-${tokenKey(input.accessToken!)}`
        : `link-sandbox-create-${tokenKey(input.clientUserId)}`,
      updateMode,
    };
  }

  async exchangePublicToken(publicToken: string): Promise<PlaidExchangeResult> {
    const existing = [...fakeItems.values()].find((item) => item.publicToken === publicToken);
    if (existing) {
      existing.loginRequired = false;
      return { accessToken: existing.accessToken, itemId: existing.itemId };
    }
    const suffix = randomUUID().slice(0, 8);
    const item: FakeItem = {
      itemId: `item-sandbox-${suffix}`,
      accessToken: `access-sandbox-${suffix}`,
      publicToken,
      institutionId: "ins_fake",
      institutionName: "First Platypus Bank",
      loginRequired: false,
      removed: false,
      accounts: defaultFakeAccounts(),
      posted: [],
      queuedAdded: [],
      queuedModified: [],
      queuedRemoved: [],
      cursorSerial: 0,
    };
    fakeItems.set(item.itemId, item);
    return { accessToken: item.accessToken, itemId: item.itemId };
  }

  async getItem(accessToken: string): Promise<PlaidInstitution> {
    const item = this.requireItem(accessToken);
    return { institutionId: item.institutionId, institutionName: item.institutionName };
  }

  async getAccounts(accessToken: string): Promise<PlaidAccount[]> {
    return this.requireItem(accessToken).accounts.map((account) => ({ ...account }));
  }

  async transactionsSync(input: { accessToken: string; cursor: string }): Promise<PlaidSyncPage> {
    const item = this.requireItem(input.accessToken);
    if (item.loginRequired) {
      throw new PlaidProviderError(
        "the login details of this item have changed",
        "ITEM_LOGIN_REQUIRED",
      );
    }
    if (!input.cursor) {
      item.cursorSerial += 1;
      return {
        added: item.posted.map((row) => ({ ...row })),
        modified: [],
        removed: [],
        nextCursor: `cursor-${item.cursorSerial}`,
        hasMore: false,
      };
    }
    item.cursorSerial += 1;
    const page: PlaidSyncPage = {
      added: item.queuedAdded.splice(0, item.queuedAdded.length),
      modified: item.queuedModified.splice(0, item.queuedModified.length),
      removed: item.queuedRemoved.splice(0, item.queuedRemoved.length),
      nextCursor: `cursor-${item.cursorSerial}`,
      hasMore: false,
    };
    return page;
  }

  async removeItem(accessToken: string): Promise<void> {
    const item = this.requireItem(accessToken);
    item.removed = true;
    item.accessToken = `removed-${item.accessToken}`;
  }

  async restoreLogin(accessToken: string): Promise<void> {
    fakePlaidRestoreLogin(accessToken);
  }

  private requireItem(accessToken: string): FakeItem {
    const item = [...fakeItems.values()].find((candidate) => candidate.accessToken === accessToken);
    if (!item || item.removed) {
      throw new PlaidProviderError("Unknown fake Plaid item.", "ITEM_NOT_FOUND");
    }
    return item;
  }
}

function plaidHost(env: PlaidEnvironment) {
  if (env === "production") return "https://production.plaid.com";
  if (env === "development") return "https://development.plaid.com";
  return "https://sandbox.plaid.com";
}

export class LivePlaidProvider implements PlaidProvider {
  readonly id = "plaid" as const;
  private readonly config: {
    clientId: string;
    secret: string;
    env: PlaidEnvironment;
  };

  constructor(config: {
    clientId: string;
    secret: string;
    env: PlaidEnvironment;
  }) {
    this.config = config;
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${plaidHost(this.config.env)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        secret: this.config.secret,
        ...body,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      error_code?: string;
      error_message?: string;
    };
    if (!response.ok) {
      throw new PlaidProviderError(
        payload.error_message || `Plaid ${path} failed.`,
        payload.error_code || "PLAID_ERROR",
      );
    }
    return payload as T;
  }

  async createLinkToken(input: {
    clientUserId: string;
    accessToken?: string;
    webhookUrl?: string;
  }): Promise<PlaidLinkTokenResult> {
    const updateMode = Boolean(input.accessToken);
    const payload = await this.request<{ link_token: string }>("/link/token/create", {
      user: { client_user_id: input.clientUserId },
      client_name: "TBBT",
      language: "en",
      country_codes: ["US"],
      products: updateMode ? undefined : ["transactions"],
      access_token: input.accessToken,
      webhook: input.webhookUrl,
      transactions: updateMode ? undefined : { days_requested: 90 },
    });
    return { linkToken: payload.link_token, updateMode };
  }

  async exchangePublicToken(publicToken: string): Promise<PlaidExchangeResult> {
    const payload = await this.request<{ access_token: string; item_id: string }>(
      "/item/public_token/exchange",
      { public_token: publicToken },
    );
    return { accessToken: payload.access_token, itemId: payload.item_id };
  }

  async getItem(accessToken: string): Promise<PlaidInstitution> {
    const payload = await this.request<{
      item?: { institution_id?: string };
    }>("/item/get", { access_token: accessToken });
    const institutionId = payload.item?.institution_id ?? null;
    if (!institutionId) {
      return { institutionId: null, institutionName: "Connected bank" };
    }
    const institution = await this.request<{ institution?: { name?: string } }>(
      "/institutions/get_by_id",
      { institution_id: institutionId, country_codes: ["US"] },
    );
    return {
      institutionId,
      institutionName: institution.institution?.name?.trim() || "Connected bank",
    };
  }

  async getAccounts(accessToken: string): Promise<PlaidAccount[]> {
    const payload = await this.request<{
      accounts?: Array<{
        account_id: string;
        name?: string;
        official_name?: string;
        mask?: string;
        type?: string;
        subtype?: string;
      }>;
    }>("/accounts/get", { access_token: accessToken });
    return (payload.accounts ?? []).map((account) => ({
      accountId: account.account_id,
      name: account.name?.trim() || "Account",
      officialName: account.official_name ?? null,
      mask: account.mask ?? null,
      type: account.type ?? "depository",
      subtype: account.subtype ?? null,
    }));
  }

  async transactionsSync(input: { accessToken: string; cursor: string }): Promise<PlaidSyncPage> {
    const payload = await this.request<{
      added?: Array<Record<string, unknown>>;
      modified?: Array<Record<string, unknown>>;
      removed?: Array<{ transaction_id?: string }>;
      next_cursor?: string;
      has_more?: boolean;
    }>("/transactions/sync", {
      access_token: input.accessToken,
      cursor: input.cursor || undefined,
      count: 500,
    });
    const mapTxn = (row: Record<string, unknown>): PlaidSyncedTransaction => ({
      transactionId: String(row.transaction_id ?? ""),
      accountId: String(row.account_id ?? ""),
      date: String(row.date ?? ""),
      name: String(row.name ?? row.merchant_name ?? "Bank transaction"),
      amount: Number(row.amount ?? 0),
      pending: row.pending === true,
    });
    return {
      added: (payload.added ?? []).map(mapTxn).filter((row) => row.transactionId),
      modified: (payload.modified ?? []).map(mapTxn).filter((row) => row.transactionId),
      removed: (payload.removed ?? [])
        .map((row) => String(row.transaction_id ?? ""))
        .filter(Boolean),
      nextCursor: payload.next_cursor ?? input.cursor,
      hasMore: payload.has_more === true,
    };
  }

  async removeItem(accessToken: string): Promise<void> {
    await this.request("/item/remove", { access_token: accessToken });
  }

  async restoreLogin(_accessToken: string): Promise<void> {
    /* Live update-mode Link restores the Item; no extra API call. */
  }
}

export function resolvePlaidEnvironment(value: string | undefined): PlaidEnvironment {
  if (value === "production" || value === "development" || value === "sandbox") return value;
  return "sandbox";
}

export function resolvePlaidWebhookUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.PLAID_WEBHOOK_URL?.trim();
  if (explicit) return explicit;
  const app = env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (!app) return undefined;
  return `${app}${PLAID_WEBHOOK_PATH}`;
}

export function resolvePlaidProvider(env: NodeJS.ProcessEnv = process.env): PlaidProvider {
  const adapter = (env.TBBT_PLAID_ADAPTER ?? "").trim().toLowerCase();
  if (adapter === "fake") return new FakePlaidProvider();
  const clientId = env.PLAID_CLIENT_ID?.trim() ?? "";
  const secret = env.PLAID_SECRET?.trim() ?? "";
  if (adapter === "plaid" || (clientId && secret)) {
    if (!clientId || !secret) {
      throw new PlaidProviderError(BANK_CONNECT_NOT_CONFIGURED_FALLBACK);
    }
    return new LivePlaidProvider({
      clientId,
      secret,
      env: resolvePlaidEnvironment(env.PLAID_ENV),
    });
  }
  throw new PlaidProviderError(BANK_CONNECT_NOT_CONFIGURED_FALLBACK, "NOT_CONFIGURED");
}

const BANK_CONNECT_NOT_CONFIGURED_FALLBACK =
  "Plaid is not configured in this environment. The owner must supply Plaid API credentials in the host environment — never a bank login.";

export function plaidAdapterKind(env: NodeJS.ProcessEnv = process.env): "fake" | "plaid" | "unconfigured" {
  const adapter = (env.TBBT_PLAID_ADAPTER ?? "").trim().toLowerCase();
  if (adapter === "fake") return "fake";
  if (adapter === "plaid" || (env.PLAID_CLIENT_ID?.trim() && env.PLAID_SECRET?.trim())) return "plaid";
  return "unconfigured";
}
