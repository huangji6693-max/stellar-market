import { logger } from "../lib/logger";

export const MAX_CURSOR_LIMIT = 50;
export const DEFAULT_CURSOR_LIMIT = 20;
export const OFFSET_DEPRECATION_WARNING =
  "Offset pagination (?page=) is deprecated. Please use cursor pagination (?cursor=&limit=) instead.";

export interface CursorPayload {
  id: string;
  createdAt: string;
}

export interface DecodedCursor {
  id: string;
  createdAt: Date;
}

export interface CursorPaginationEnvelope<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  deprecationWarning?: string;
}

/**
 * Encodes an item's `id` and `createdAt` into a base64 opaque cursor string.
 */
export function encodeCursor(item: {
  id: string;
  createdAt: Date | string;
}): string {
  const createdAtIso =
    item.createdAt instanceof Date
      ? item.createdAt.toISOString()
      : new Date(item.createdAt).toISOString();
  const payload: CursorPayload = {
    id: item.id,
    createdAt: createdAtIso,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/**
 * Decodes a base64 opaque cursor into `{ id, createdAt }`.
 * Returns `null` if the cursor is malformed or missing required fields.
 */
export function decodeCursor(cursor: string | undefined): DecodedCursor | null {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const raw = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<CursorPayload>;
    if (!parsed.id || typeof parsed.id !== "string" || !parsed.createdAt) {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return { id: parsed.id, createdAt };
  } catch {
    return null;
  }
}

/**
 * Clamps the requested limit to `[1, maxLimit]` (default max 50).
 */
export function clampCursorLimit(
  limit: unknown,
  defaultLimit = DEFAULT_CURSOR_LIMIT,
  maxLimit = MAX_CURSOR_LIMIT,
): number {
  const num = Number(limit);
  if (!Number.isFinite(num) || num < 1) return defaultLimit;
  return Math.min(Math.floor(num), maxLimit);
}

/**
 * Builds a Prisma keyset WHERE filter for `(createdAt, id)` comparison that uses
 * composite `(createdAt, id)` index seeks without sequential scans.
 */
export function buildCursorWhereClause(
  cursor: DecodedCursor,
  direction: "asc" | "desc" = "desc",
) {
  const op = direction === "desc" ? "lt" : "gt";
  return {
    OR: [
      { createdAt: { [op]: cursor.createdAt } },
      {
        AND: [{ createdAt: cursor.createdAt }, { id: { [op]: cursor.id } }],
      },
    ],
  };
}

/**
 * Slices a `take: limit + 1` result set into `{ data, nextCursor, hasMore }`.
 */
export function buildCursorPage<
  T extends { id: string; createdAt: Date | string },
>(rows: T[], limit: number): CursorPaginationEnvelope<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = data[data.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem) : null;
  return {
    data,
    nextCursor,
    hasMore,
  };
}

/**
 * Determines whether the caller explicitly passed `?page=` in the request query string.
 */
export function hasExplicitPageParam(req: {
  originalUrl?: string;
  url?: string;
  query?: Record<string, unknown>;
}): boolean {
  const rawUrl = req.originalUrl || req.url;
  if (typeof rawUrl === "string" && rawUrl.length > 0) {
    return /(?:^|[?&])page=/.test(rawUrl);
  }
  return req.query?.page !== undefined && req.query?.cursor === undefined;
}

/**
 * Logs a server-side deprecation warning when offset pagination (`?page=`) is used.
 */
export function logOffsetDeprecation(endpoint: string, page: unknown): string {
  logger.warn(
    { endpoint, page },
    OFFSET_DEPRECATION_WARNING,
  );
  return OFFSET_DEPRECATION_WARNING;
}
