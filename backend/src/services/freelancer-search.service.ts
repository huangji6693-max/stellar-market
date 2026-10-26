import { Prisma, PrismaClient } from "@prisma/client";
import { decodeCursor, encodeCursor, MAX_CURSOR_LIMIT } from "../utils/cursorPagination";

export type FreelancerSearchInput = {
  page: number;
  limit: number;
  cursor?: string;
  minRating?: number;
  available?: boolean;
  q?: string;
  skills?: string[];
};

export type FreelancerSearchApiRow = {
  id: string;
  name: string;
  avatarUrl: string | null;
  bio: string | null;
  skills: string[];
  averageRating: number;
  completedJobs: number;
  isAvailable: boolean;
  createdAt?: Date;
};

function sanitizeLikeToken(s: string): string {
  return s.replace(/[%_\\]/g, "").trim().slice(0, 200);
}

function buildWhereSql(input: FreelancerSearchInput): Prisma.Sql {
  const parts: Prisma.Sql[] = [
    Prisma.sql`u.role = 'FREELANCER'::"UserRole"`,
    Prisma.sql`u."isSuspended" = false`,
  ];

  if (input.minRating !== undefined) {
    parts.push(Prisma.sql`u."averageRating" >= ${input.minRating}`);
  }
  if (input.available !== undefined) {
    parts.push(Prisma.sql`u.availability = ${input.available}`);
  }
  const q = input.q?.trim();
  if (q) {
    const token = sanitizeLikeToken(q);
    if (token) {
      const pattern = `%${token}%`;
      parts.push(
        Prisma.sql`(u.username ILIKE ${pattern} OR (u.bio IS NOT NULL AND u.bio ILIKE ${pattern}))`
      );
    }
  }
  for (const raw of input.skills ?? []) {
    const token = sanitizeLikeToken(raw);
    if (!token) continue;
    const pattern = `%${token}%`;
    parts.push(
      Prisma.sql`array_to_string(u.skills, ' ') ILIKE ${pattern}`
    );
  }

  const decoded = decodeCursor(input.cursor);
  if (decoded) {
    parts.push(
      Prisma.sql`(u."createdAt" < ${decoded.createdAt} OR (u."createdAt" = ${decoded.createdAt} AND u.id < ${decoded.id}))`
    );
  }

  return Prisma.join(parts, " AND ");
}

type RawRow = {
  id: string;
  username: string;
  avatarUrl: string | null;
  bio: string | null;
  skills: string[];
  averageRating: unknown;
  availability: boolean;
  completedJobs: unknown;
  createdAt?: Date;
};

export async function searchFreelancers(
  prisma: PrismaClient,
  input: FreelancerSearchInput
): Promise<{
  data: FreelancerSearchApiRow[];
  nextCursor: string | null;
  hasMore: boolean;
  meta: { total: number; page: number; limit: number; totalPages: number };
}> {
  const useCursor = Boolean(input.cursor);
  const safeLimit = useCursor ? Math.min(Math.max(1, input.limit), MAX_CURSOR_LIMIT) : input.limit;
  const skip = useCursor ? 0 : (input.page - 1) * safeLimit;
  const fetchLimit = useCursor ? safeLimit + 1 : safeLimit;
  const whereSql = buildWhereSql(input);

  const countRows = await prisma.$queryRaw<[{ n: bigint }]>`
    SELECT COUNT(*)::bigint AS n FROM "User" u WHERE ${whereSql}
  `;
  const orderSql = useCursor
    ? Prisma.sql`u."createdAt" DESC, u.id DESC`
    : Prisma.sql`u."averageRating" DESC NULLS LAST, u.id ASC`;
  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT
      u.id,
      u.username,
      u."avatarUrl",
      u.bio,
      u.skills,
      u."averageRating",
      u.availability,
      u."createdAt",
      (
        SELECT COUNT(*)::int
        FROM "Job" j
        WHERE j."freelancerId" = u.id
          AND j.status = 'COMPLETED'::"JobStatus"
      ) AS "completedJobs"
    FROM "User" u
    WHERE ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ${fetchLimit} OFFSET ${skip}
  `;

  const total = Number(countRows[0]?.n ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / safeLimit);
  const hasMore = useCursor
    ? rows.length > safeLimit
    : input.page < totalPages;
  const slicedRows = useCursor && hasMore ? rows.slice(0, safeLimit) : rows;
  const lastRow = slicedRows[slicedRows.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({
          id: lastRow.id,
          createdAt: lastRow.createdAt ?? new Date(0),
        })
      : null;

  const data: FreelancerSearchApiRow[] = slicedRows.map((r) => ({
    id: r.id,
    name: r.username,
    avatarUrl: r.avatarUrl,
    bio: r.bio,
    skills: r.skills ?? [],
    averageRating: Number(r.averageRating ?? 0),
    completedJobs: Number(r.completedJobs ?? 0),
    isAvailable: r.availability,
  }));

  return {
    data,
    nextCursor,
    hasMore,
    meta: {
      total,
      page: input.page,
      limit: safeLimit,
      totalPages,
    },
  };
}
