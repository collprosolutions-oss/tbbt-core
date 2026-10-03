/**
 * Local-only disposable object-storage fixture for the Handyman
 * file-byte restore drill.
 *
 * Writes private-file bytes under $TMPDIR/tbbt_handy_restore_storage_*.
 * Snapshots and restores by directory copy. Resolves restored
 * StoredAsset references to ok / missing / mismatch without putting
 * storage keys or customer data in the report.
 *
 * Never reads or writes production R2. Never constructs an R2 client.
 * Object files are stored under a digest of (bucket, key) so a
 * directory listing does not reveal storage keys.
 */
import {
  createHash,
  randomBytes,
} from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export const HANDYMAN_RESTORE_STORAGE_PREFIX = "tbbt_handy_restore_storage_";
export const HANDYMAN_RESTORE_STORAGE_BUCKET_PREFIX = "tbbt-restore-drill-";
export const FAKE_RESTORE_BUCKET = "tbbt-restore-drill-fake";

export const R2_ENV_NAMES = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ENDPOINT",
  "R2_REGION",
];

const STORAGE_KEY_RE = /businesses\/[A-Za-z0-9_-]+\/[^\s"'`\\,)}\]]+/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/;
const CUSTOMER_LITERALS = [
  "Restore Drill Customer",
  "Other Tenant Customer",
  "12 Restore Way",
];

export class ProductionR2RefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionR2RefusedError";
  }
}

export class RestoreStoragePathRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RestoreStoragePathRefusedError";
  }
}

export class RestoreStorageBucketRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "RestoreStorageBucketRefusedError";
  }
}

export function scrubProductionR2Env(env = process.env) {
  for (const name of R2_ENV_NAMES) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      delete env[name];
    }
  }
  return env;
}

export function assertProductionR2EnvScrubbed(action = "use disposable storage") {
  const present = R2_ENV_NAMES.filter((name) => String(process.env[name] || "").trim());
  if (present.length > 0) {
    throw new ProductionR2RefusedError(
      `Refusing to ${action}: production R2 environment variables must be unset. Never read or write production R2.`,
    );
  }
}

export function refuseProductionR2Provider(action = "construct storage provider") {
  throw new ProductionR2RefusedError(
    `Refusing to ${action}: this drill uses a disposable filesystem fixture only. Never read or write production R2.`,
  );
}

export function uniqueRestoreStorageName(suffix) {
  const safe = String(suffix || "fix")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return `${HANDYMAN_RESTORE_STORAGE_PREFIX}${safe || "fix"}_${randomBytes(6).toString("hex")}`;
}

export function assertDisposableStorageRoot(rootDir, action = "use disposable storage") {
  const raw = String(rootDir || "");
  if (!raw || raw.includes("\0")) {
    throw new RestoreStoragePathRefusedError(`Refusing to ${action}: storage fixture path is empty.`);
  }
  const tmpRoot = resolve(tmpdir());
  const resolved = resolve(raw);
  const tmpPrefix = tmpRoot.endsWith(sep) ? tmpRoot : `${tmpRoot}${sep}`;
  if (resolved !== tmpRoot && !resolved.startsWith(tmpPrefix)) {
    throw new RestoreStoragePathRefusedError(
      `Refusing to ${action}: storage fixture must live under the process temp directory.`,
    );
  }
  const base = basename(resolved);
  if (!base.startsWith(HANDYMAN_RESTORE_STORAGE_PREFIX) || !/^[a-z0-9_]+$/.test(base)) {
    throw new RestoreStoragePathRefusedError(
      `Refusing to ${action}: fixture directory name must start with "${HANDYMAN_RESTORE_STORAGE_PREFIX}".`,
    );
  }
  return resolved;
}

export function assertRestoreDrillBucket(bucket, action = "use disposable storage") {
  const name = String(bucket || "");
  if (
    !name ||
    !name.startsWith(HANDYMAN_RESTORE_STORAGE_BUCKET_PREFIX) ||
    !/^[a-z0-9-]+$/.test(name)
  ) {
    throw new RestoreStorageBucketRefusedError(
      `Refusing to ${action}: bucket name must start with "${HANDYMAN_RESTORE_STORAGE_BUCKET_PREFIX}".`,
    );
  }
  return name;
}

function assertSafeStorageKey(key, action = "use disposable storage") {
  const value = String(key || "");
  if (!value || value.includes("..") || value.includes("\\") || value.startsWith("/") || value.includes("\0")) {
    throw new RestoreStoragePathRefusedError(`Refusing to ${action}: storage key is not a safe relative object path.`);
  }
  return value;
}

export function digestBytes(body) {
  return createHash("sha256").update(Buffer.from(body)).digest("hex");
}

/** Same-length corruption: flip one byte so size checks cannot hide a digest miss. */
export function flipOneByte(body, index = 0) {
  const buf = Buffer.from(body);
  if (buf.byteLength === 0) {
    throw new Error("Cannot flip a byte in an empty buffer.");
  }
  const at = ((index % buf.byteLength) + buf.byteLength) % buf.byteLength;
  buf[at] = buf[at] ^ 0xff;
  return buf;
}

export function digestStorageLocator(bucket, key) {
  const safeBucket = assertRestoreDrillBucket(bucket, "digest storage locator");
  const safeKey = assertSafeStorageKey(key, "digest storage locator");
  return createHash("sha256").update(`${safeBucket}\0${safeKey}`, "utf8").digest("hex");
}

export function expectedBytesMeta(body) {
  const buf = Buffer.from(body);
  return {
    expectedSha256: digestBytes(buf),
    expectedSizeBytes: buf.byteLength,
  };
}

export function redactRestoreLog(text) {
  let out = String(text ?? "");
  out = out.replace(new RegExp(STORAGE_KEY_RE.source, "g"), "[storage-key]");
  out = out.replace(new RegExp(EMAIL_RE.source, "g"), "[email]");
  for (const literal of CUSTOMER_LITERALS) {
    out = out.split(literal).join("[customer]");
  }
  out = out.replace(new RegExp(PHONE_RE.source, "g"), "[phone]");
  return out;
}

export function containsSensitiveRestoreLog(text) {
  const raw = String(text ?? "");
  if (new RegExp(STORAGE_KEY_RE.source).test(raw)) return true;
  if (new RegExp(EMAIL_RE.source).test(raw)) return true;
  if (new RegExp(PHONE_RE.source).test(raw)) return true;
  return CUSTOMER_LITERALS.some((literal) => raw.includes(literal));
}

export function assertRestoreReportSafe(results) {
  const text = JSON.stringify(results);
  if (
    text.includes("storageKey") ||
    text.includes("originalFilename") ||
    text.includes("customerId") ||
    containsSensitiveRestoreLog(text)
  ) {
    throw new Error("Restore report leaked storage keys or customer data.");
  }
  return results;
}

export function formatRestoreReport(results) {
  assertRestoreReportSafe(results);
  return results.map((row) => `${row.objectRef}:${row.status}`).join(" ");
}

export function classifyRestoredObject({ expectedSha256, expectedSizeBytes, object }) {
  if (!object || object.body == null) return "missing";
  const actual = Buffer.from(object.body);
  if (actual.byteLength !== expectedSizeBytes) return "mismatch";
  // Size-only is not enough: a one-byte flip keeps fileSizeBytes and must still mismatch.
  if (digestBytes(actual) !== expectedSha256) return "mismatch";
  return "ok";
}

function assertOpaqueObjectRef(objectRef) {
  const ref = String(objectRef || "");
  if (!ref || ref.includes("/") || ref.includes("@") || ref.includes("\\") || ref.startsWith("businesses")) {
    throw new Error("objectRef must be an opaque label, not a storage key or customer field.");
  }
  return ref;
}

/**
 * Resolve restored database references against a storage getter.
 * `storageKey` is used only to fetch. The returned rows are
 * `{ objectRef, status }` — never a key, path, or customer field.
 */
export async function resolveRestoredPrivateObjects(references, getObject) {
  const results = [];
  for (const ref of references) {
    const objectRef = assertOpaqueObjectRef(ref.objectRef);
    const object = await getObject({
      bucket: ref.bucket,
      key: ref.storageKey,
    });
    results.push({
      objectRef,
      status: classifyRestoredObject({
        expectedSha256: ref.expectedSha256,
        expectedSizeBytes: ref.expectedSizeBytes,
        object,
      }),
    });
  }
  return assertRestoreReportSafe(results);
}

export class DisposableFilesystemStorageProvider {
  constructor(rootDir) {
    this.id = "FILESYSTEM";
    this.rootDir = assertDisposableStorageRoot(rootDir, "open disposable filesystem provider");
  }

  #paths(bucket, key) {
    const digest = digestStorageLocator(bucket, key);
    const dir = join(this.rootDir, "objects");
    return {
      digest,
      dir,
      bodyPath: join(dir, `${digest}.bin`),
      metaPath: join(dir, `${digest}.meta.json`),
    };
  }

  async putObject(input) {
    const { dir, bodyPath, metaPath } = this.#paths(input.bucket, input.key);
    mkdirSync(dir, { recursive: true });
    const body = Buffer.from(input.body);
    writeFileSync(bodyPath, body);
    writeFileSync(
      metaPath,
      JSON.stringify({
        contentType: input.contentType,
        sizeBytes: body.byteLength,
      }),
    );
    return {
      key: input.key,
      sizeBytes: body.byteLength,
      contentType: input.contentType,
    };
  }

  async deleteObject(input) {
    const { bodyPath, metaPath } = this.#paths(input.bucket, input.key);
    rmSync(bodyPath, { force: true });
    rmSync(metaPath, { force: true });
  }

  async getObjectMetadata(input) {
    const { metaPath } = this.#paths(input.bucket, input.key);
    if (!existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      key: input.key,
      sizeBytes: Number(meta.sizeBytes) || 0,
      contentType: meta.contentType,
    };
  }

  async getObject(input) {
    const { bodyPath, metaPath } = this.#paths(input.bucket, input.key);
    if (!existsSync(bodyPath)) return null;
    const body = new Uint8Array(readFileSync(bodyPath));
    const meta = existsSync(metaPath)
      ? JSON.parse(readFileSync(metaPath, "utf8"))
      : { contentType: undefined };
    return {
      key: input.key,
      body,
      sizeBytes: body.byteLength,
      contentType: meta.contentType,
    };
  }

  async objectExists(input) {
    const { bodyPath } = this.#paths(input.bucket, input.key);
    return existsSync(bodyPath);
  }

  async createUploadUrl(input) {
    const digest = digestStorageLocator(input.bucket, input.key);
    return {
      url: `filesystem://upload/${digest}`,
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.contentLength),
      },
      expiresInSeconds: input.expiresInSeconds,
    };
  }

  async createDownloadUrl(input) {
    const digest = digestStorageLocator(input.bucket, input.key);
    void input.contentType;
    void input.contentDisposition;
    return {
      url: `filesystem://download/${digest}`,
      expiresInSeconds: input.expiresInSeconds,
    };
  }
}

export function countFixtureObjects(rootDir) {
  const root = assertDisposableStorageRoot(rootDir, "count disposable storage objects");
  const dir = join(root, "objects");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".bin")).length;
}

export function openExistingDisposableStorageFixture(rootDir) {
  assertProductionR2EnvScrubbed("open disposable storage");
  const root = assertDisposableStorageRoot(rootDir, "open disposable storage");
  return {
    rootDir: root,
    bucket: FAKE_RESTORE_BUCKET,
    provider: new DisposableFilesystemStorageProvider(root),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function openDisposableStorageFixture({ nameSuffix = "fix" } = {}) {
  assertProductionR2EnvScrubbed("create disposable storage");
  const root = join(tmpdir(), uniqueRestoreStorageName(nameSuffix));
  mkdirSync(root, { recursive: true });
  return openExistingDisposableStorageFixture(root);
}

export function copyDisposableStorageFixture(sourceRoot, { nameSuffix = "copy" } = {}) {
  assertProductionR2EnvScrubbed("copy disposable storage");
  const source = assertDisposableStorageRoot(sourceRoot, "snapshot disposable storage");
  const dest = join(tmpdir(), uniqueRestoreStorageName(nameSuffix));
  cpSync(source, dest, { recursive: true, dereference: true });
  return openExistingDisposableStorageFixture(dest);
}
