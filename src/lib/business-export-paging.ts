/**
 * Bounded reads for the owner/admin business ZIP.
 *
 * Pages matching tenant rows instead of one unbounded findMany. If a
 * collection or archive cannot be finished without dropping rows, the
 * export fails instead of writing a partial ZIP.
 */
import { csvBody, csvHeaderLine } from "@/lib/zip-store";

export const BUSINESS_EXPORT_PAGE_SIZE = 500;
export const BUSINESS_EXPORT_MAX_ROWS_PER_COLLECTION = 50_000;
export const BUSINESS_EXPORT_MAX_ZIP_BYTES = 256 * 1024 * 1024;
export const BUSINESS_EXPORT_MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
export const BUSINESS_EXPORT_MAX_DOCUMENTS = 2_000;

export const BUSINESS_EXPORT_INCOMPLETE_PREFIX =
  "Business export cannot complete safely:";
export const BUSINESS_EXPORT_INCOMPLETE_SUFFIX =
  "No ZIP was written and no matching records were omitted.";

export class BusinessExportIncompleteError extends Error {
  readonly code = "BUSINESS_EXPORT_INCOMPLETE";
  readonly collection: string;

  constructor(collection: string, detail: string) {
    super(
      `${BUSINESS_EXPORT_INCOMPLETE_PREFIX} ${detail} ${BUSINESS_EXPORT_INCOMPLETE_SUFFIX}`,
    );
    this.name = "BusinessExportIncompleteError";
    this.collection = collection;
  }
}

export type BusinessExportLimits = {
  pageSize: number;
  maxRowsPerCollection: number;
  maxZipBytes: number;
  maxDocumentBytes: number;
  maxDocuments: number;
};

export function defaultBusinessExportLimits(): BusinessExportLimits {
  return {
    pageSize: BUSINESS_EXPORT_PAGE_SIZE,
    maxRowsPerCollection: BUSINESS_EXPORT_MAX_ROWS_PER_COLLECTION,
    maxZipBytes: BUSINESS_EXPORT_MAX_ZIP_BYTES,
    maxDocumentBytes: BUSINESS_EXPORT_MAX_DOCUMENT_BYTES,
    maxDocuments: BUSINESS_EXPORT_MAX_DOCUMENTS,
  };
}

export function resolveBusinessExportLimits(
  overrides?: Partial<BusinessExportLimits>,
): BusinessExportLimits {
  const defaults = defaultBusinessExportLimits();
  const merged = { ...defaults, ...overrides };
  if (
    !Number.isInteger(merged.pageSize) ||
    merged.pageSize < 1 ||
    !Number.isInteger(merged.maxRowsPerCollection) ||
    merged.maxRowsPerCollection < 1 ||
    !Number.isFinite(merged.maxZipBytes) ||
    merged.maxZipBytes < 1 ||
    !Number.isFinite(merged.maxDocumentBytes) ||
    merged.maxDocumentBytes < 1 ||
    !Number.isInteger(merged.maxDocuments) ||
    merged.maxDocuments < 0
  ) {
    throw new BusinessExportIncompleteError(
      "limits",
      "export page or size limits are invalid.",
    );
  }
  return merged;
}

export type PagedFindManyArgs = {
  take: number;
  skip?: number;
  cursor?: { id: string };
};

export type PagedFindMany<T> = (args: PagedFindManyArgs) => Promise<T[]>;

export type StreamPagedRowsResult = {
  count: number;
  pages: number;
};

function assertSafeLimits(collection: string, limits: BusinessExportLimits) {
  if (limits.pageSize < 1 || limits.maxRowsPerCollection < 1) {
    throw new BusinessExportIncompleteError(
      collection,
      `${collection} export page limits are invalid.`,
    );
  }
}

export async function streamPagedRows<T extends { id: string }>(
  findMany: PagedFindMany<T>,
  options: {
    collection: string;
    limits: BusinessExportLimits;
    consume: (rows: readonly T[]) => void | Promise<void>;
  },
): Promise<StreamPagedRowsResult> {
  assertSafeLimits(options.collection, options.limits);
  const pageSize = options.limits.pageSize;
  const maxRows = options.limits.maxRowsPerCollection;
  let count = 0;
  let pages = 0;
  let cursor: { id: string } | undefined;

  while (true) {
    const fetched = await findMany({
      take: pageSize + 1,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    pages += 1;
    const hasMore = fetched.length > pageSize;
    const rows = hasMore ? fetched.slice(0, pageSize) : fetched;
    const nextCount = count + rows.length;
    if (nextCount > maxRows || (hasMore && nextCount === maxRows)) {
      throw new BusinessExportIncompleteError(
        options.collection,
        `${options.collection} has more than ${maxRows} matching rows.`,
      );
    }
    if (rows.length > 0) {
      await options.consume(rows);
    }
    count = nextCount;
    if (!hasMore) {
      return { count, pages };
    }
    const last = rows[rows.length - 1];
    if (!last) {
      throw new BusinessExportIncompleteError(
        options.collection,
        `${options.collection} paging stopped before the last matching row.`,
      );
    }
    cursor = { id: last.id };
  }
}

export async function collectPagedRows<T extends { id: string }>(
  findMany: PagedFindMany<T>,
  options: {
    collection: string;
    limits: BusinessExportLimits;
  },
): Promise<T[]> {
  const items: T[] = [];
  await streamPagedRows(findMany, {
    collection: options.collection,
    limits: options.limits,
    consume: (rows) => {
      items.push(...rows);
    },
  });
  return items;
}

export function headersOf(rows: ReadonlyArray<object>): string[] {
  const first = rows[0];
  return first ? Object.keys(first) : ["id"];
}

export function asCsvRows<T extends object>(rows: readonly T[]): Array<Record<string, unknown>> {
  return rows as Array<Record<string, unknown>>;
}

export async function exportPagedCsv<T extends { id: string }>(
  findMany: PagedFindMany<T>,
  options: {
    collection: string;
    limits: BusinessExportLimits;
    headers?: string[];
    mapRow?: (row: T) => Record<string, unknown>;
  },
): Promise<string> {
  let headers = options.headers;
  const chunks: string[] = [];
  await streamPagedRows(findMany, {
    collection: options.collection,
    limits: options.limits,
    consume: (rows) => {
      const mapped = options.mapRow
        ? rows.map(options.mapRow)
        : (rows as unknown as Array<Record<string, unknown>>);
      if (!headers) {
        headers = headersOf(mapped);
      }
      chunks.push(csvBody(headers, mapped));
    },
  });
  return `${csvHeaderLine(headers ?? ["id"])}${chunks.join("")}`;
}
