import { PrismaClient, BadgeTier } from "@prisma/client";
import { 
  cache,
  generateRecommendationsSnapshotCacheKey,
  invalidateCache
} from "../lib/cache";
import { ReputationCacheService, OnChainReputation } from "./reputation-cache.service";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
export const recommendationPrisma = prisma;

export const RECOMMENDATION_SNAPSHOT_TTL_SECONDS = 60;

export interface RecommendationCursorPayload {
  score: number;
  createdAt: string;
  id: string;
  snapshotId: string;
}

export interface RecommendationPaginationOptions {
  cursor?: string;
  snapshotId?: string;
}

interface RankedRecommendationItem {
  id: string;
  createdAt: Date | string;
  relevanceScore: number;
  [key: string]: unknown;
}

interface RecommendationSnapshot<T extends RankedRecommendationItem = RankedRecommendationItem> {
  snapshotId: string;
  createdAtMs: number;
  items: T[];
}

const memorySnapshots = new Map<string, RecommendationSnapshot>();
const userSnapshotGeneration = new Map<string, number>();

/**
 * Deterministic comparator for scored job recommendations (issue #1123):
 * 1. Higher relevanceScore first (DESC)
 * 2. More recent createdAt first (DESC)
 * 3. Lexicographically smaller job id first (ASC)
 */
export function compareRecommendedJobs(
  a: Pick<RankedRecommendationItem, "relevanceScore" | "createdAt" | "id">,
  b: Pick<RankedRecommendationItem, "relevanceScore" | "createdAt" | "id">
): number {
  if (b.relevanceScore !== a.relevanceScore) {
    return b.relevanceScore - a.relevanceScore;
  }
  const timeA = new Date(a.createdAt).getTime();
  const timeB = new Date(b.createdAt).getTime();
  if (timeB !== timeA) {
    return timeB - timeA;
  }
  return String(a.id).localeCompare(String(b.id));
}

export function encodeRecommendationCursor(payload: RecommendationCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRecommendationCursor(cursor: string): RecommendationCursorPayload | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as Partial<RecommendationCursorPayload>;
    if (
      typeof parsed.score !== "number" ||
      !Number.isFinite(parsed.score) ||
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(new Date(parsed.createdAt).getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.snapshotId !== "string" ||
      parsed.snapshotId.length === 0
    ) {
      return null;
    }
    return {
      score: parsed.score,
      createdAt: parsed.createdAt,
      id: parsed.id,
      snapshotId: parsed.snapshotId,
    };
  } catch {
    return null;
  }
}

/**
 * Weight configuration for scoring components
 * 
 * These weights balance traditional signals (skills, history) with on-chain trust signals.
 * The distribution reflects that skill match is most critical, followed by on-chain reputation,
 * then completion history, dispute record, endorsements, and response time.
 * 
 * Weights should be revisited once real user data is available for A/B testing.
 */
interface ScoringWeights {
  skillOverlap: number;       // Skill match to job requirements
  completionRate: number;     // Jobs completed / jobs accepted from DB
  onChainTier: number;        // Badge tier from reputation contract
  disputeLossRate: number;    // Penalty for dispute losses
  endorsementWeight: number;  // Stake-weighted endorsements
  responseTime: number;       // Average time to first message (future)
  recency: number;            // How recently the job was posted
  clientReputation: number;   // Client average rating (normalized)
}

export const WEIGHTS: ScoringWeights = {
  skillOverlap: 0.20,
  completionRate: 0.15,
  onChainTier: 0.20,
  disputeLossRate: 0.10,
  endorsementWeight: 0.08,
  responseTime: 0.05,
  recency: 0.12,
  clientReputation: 0.10,
};

/** Max age in days for recency scoring — jobs older than this get 0 recency score */
const RECENCY_WINDOW_DAYS = 30;

/**
 * Computes Jaccard similarity between two string arrays.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 * Returns 0 when both sets are empty.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.toLowerCase()));
  const setB = new Set(b.map((s) => s.toLowerCase()));

  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) intersectionSize++;
  }

  const unionSize = new Set([...setA, ...setB]).size;
  return intersectionSize / unionSize;
}

/**
 * Computes category affinity score.
 * Returns 1 if the job's category is in the freelancer's completed categories, 0 otherwise.
 */
export function categoryAffinityScore(
  jobCategory: string,
  completedCategories: string[]
): number {
  const normalizedJob = jobCategory.toLowerCase();
  return completedCategories.some((c) => c.toLowerCase() === normalizedJob)
    ? 1
    : 0;
}

/**
 * Computes recency score based on how recently a job was posted.
 * Returns a value between 0 and 1. Jobs posted today score 1,
 * jobs older than RECENCY_WINDOW_DAYS score 0.
 */
export function recencyScore(createdAt: Date, now: Date = new Date()): number {
  const ageMs = now.getTime() - createdAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Clamp age to prevent negative values (future dates) from producing scores > 1
  if (ageDays <= 0) return 1;
  if (ageDays >= RECENCY_WINDOW_DAYS) return 0;
  return 1 - ageDays / RECENCY_WINDOW_DAYS;
}

/**
 * Computes reputation score for a client.
 * Normalizes the average rating to a 0–1 scale (rating / 5).
 * Returns 0 if no reviews exist.
 */
export function reputationScore(averageRating: number): number {
  return Math.min(Math.max(averageRating / 5, 0), 1);
}

/**
 * Computes on-chain badge tier score.
 * Maps BadgeTier enum to normalized scores:
 * - BRONZE: 0.2
 * - SILVER: 0.4
 * - GOLD: 0.7
 * - PLATINUM: 1.0
 * - No tier: 0.5 (neutral fallback when RPC unavailable)
 */
export function badgeTierScore(tier: BadgeTier | null, isFallback: boolean = false): number {
  if (!tier) return isFallback ? 0.5 : 0;
  
  switch (tier) {
    case BadgeTier.BRONZE:
      return 0.2;
    case BadgeTier.SILVER:
      return 0.4;
    case BadgeTier.GOLD:
      return 0.7;
    case BadgeTier.PLATINUM:
      return 1.0;
    default:
      return 0;
  }
}

/**
 * Computes dispute loss rate penalty.
 * Higher dispute loss rate = lower score.
 * - 0% disputes: 1.0
 * - 30%+ disputes: 0.0
 * - Neutral fallback: 0.5 (when RPC unavailable)
 */
export function disputeLossRateScore(rate: number, isFallback: boolean = false): number {
  if (isFallback) return 0.5;
  
  // Linear penalty: 1.0 at 0%, 0.0 at 30%+
  const threshold = 0.3;
  if (rate >= threshold) return 0;
  return 1 - (rate / threshold);
}

/**
 * Computes completion rate score from DB history.
 * - completion_rate = completed_jobs / (completed_jobs + cancelled_jobs + disputed_jobs)
 * - Normalized to 0-1 range
 */
export function completionRateScore(completedJobs: number, totalJobs: number): number {
  if (totalJobs === 0) return 0.5; // Neutral for new users
  return completedJobs / totalJobs;
}

/**
 * Computes the combined relevance score for a job given a freelancer's profile.
 * Integrates both traditional DB signals and on-chain reputation signals.
 */
export function computeRelevanceScore(params: {
  freelancerSkills: string[];
  jobSkills: string[];
  jobCategory: string;
  completedCategories: string[];
  jobCreatedAt: Date;
  clientAverageRating: number;
  onChainReputation: OnChainReputation | null;
  completedJobsCount: number;
  totalJobsCount: number;
  isRpcFallback?: boolean; // True when RPC is unavailable
  now?: Date;
}): number {
  // Traditional signals
  const skillScore = jaccardSimilarity(
    params.freelancerSkills,
    params.jobSkills
  );
  // On-chain signals (with fallback to neutral when unavailable)
  const isFallback = params.isRpcFallback || !params.onChainReputation;
  const tierScore = badgeTierScore(
    params.onChainReputation?.tier ?? null,
    isFallback
  );
  const disputeScore = disputeLossRateScore(
    params.onChainReputation?.disputeLossRate ?? 0,
    isFallback
  );
  const endorsementScore = params.onChainReputation?.endorsementWeight ?? (isFallback ? 0.5 : 0);
  
  // DB-based completion rate
  const completionScore = completionRateScore(
    params.completedJobsCount,
    params.totalJobsCount
  );
  
  // Response time (placeholder - always neutral for now)
  const responseScore = 0.5;

  return (
    WEIGHTS.skillOverlap * skillScore +
    WEIGHTS.completionRate * completionScore +
    WEIGHTS.onChainTier * tierScore +
    WEIGHTS.disputeLossRate * disputeScore +
    WEIGHTS.endorsementWeight * endorsementScore +
    WEIGHTS.responseTime * responseScore +
    WEIGHTS.recency * recencyScore(params.jobCreatedAt, params.now ?? new Date()) +
    WEIGHTS.clientReputation * reputationScore(params.clientAverageRating)
  );
}

export class RecommendationService {
  /**
   * Returns paginated job recommendations for a freelancer, scored by relevance.
   * Integrates on-chain reputation signals with traditional DB signals.
   *
   * Pagination consistency (issue #1123):
   * - Caches the full deterministically ranked snapshot per user (60s TTL) rather than
   *   caching isolated `(page, limit)` slices.
   * - Subsequent pages (`page > 1`) and cursor/snapshot requests slice from the same
   *   ranked snapshot so concurrent job insertions or score changes never duplicate or skip items.
   * - Supports both `(page, limit)` offset pagination and opaque `cursor` keyset pagination
   *   with deterministic tie-breaking `(relevanceScore DESC, createdAt DESC, id ASC)`.
   */
  static async getRecommendedJobs(
    userId: string,
    page: number = 1,
    limit: number = 10,
    options?: RecommendationPaginationOptions
  ) {
    const decodedCursor = options?.cursor
      ? decodeRecommendationCursor(options.cursor)
      : null;

    const nowMs = Date.now();
    const ttlMs = RECOMMENDATION_SNAPSHOT_TTL_SECONDS * 1000;
    const reuseExistingSnapshot =
      page > 1 || Boolean(decodedCursor) || Boolean(options?.snapshotId);

    const currentGen = userSnapshotGeneration.get(userId) ?? 1;
    const requestedSnapshotId =
      decodedCursor?.snapshotId ??
      options?.snapshotId ??
      `v${currentGen}`;

    const existingMemSnapshot = memorySnapshots.get(`${userId}:${requestedSnapshotId}`);
    if (
      reuseExistingSnapshot &&
      existingMemSnapshot &&
      nowMs - existingMemSnapshot.createdAtMs < ttlMs
    ) {
      return RecommendationService.paginateSnapshot(
        existingMemSnapshot,
        page,
        limit,
        decodedCursor
      );
    }

    const activeSnapshotId = reuseExistingSnapshot
      ? requestedSnapshotId
      : `v${currentGen}`;
    const snapshotCacheKey = generateRecommendationsSnapshotCacheKey(
      userId,
      activeSnapshotId
    );

    const { data: snapshot } = await cache<RecommendationSnapshot | null>(
      snapshotCacheKey,
      RECOMMENDATION_SNAPSHOT_TTL_SECONDS,
      async () => {
        // 1. Fetch freelancer's skills and wallet address
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            skills: true,
            role: true,
            walletAddress: true,
          },
        });

        if (!user || user.role !== "FREELANCER") {
          return null;
        }

        // 2. Get categories from freelancer's completed jobs
        const completedJobs = await prisma.job.findMany({
          where: { freelancerId: userId, status: "COMPLETED" },
          select: { category: true },
        });
        const completedCategories = [
          ...new Set(completedJobs.map((j) => j.category)),
        ];

        // 3. Calculate freelancer's completion rate from DB
        const totalJobsCount = await prisma.job.count({
          where: {
            freelancerId: userId,
            status: { in: ["COMPLETED", "CANCELLED", "DISPUTED"] },
          },
        });
        const completedJobsCount = completedJobs.length;

        // 4. Get job IDs the freelancer already applied to (to exclude)
        const appliedApplications = await prisma.application.findMany({
          where: { freelancerId: userId },
          select: { jobId: true },
        });
        const appliedJobIds = appliedApplications.map((a) => a.jobId);

        // 5. Fetch all open, unflagged jobs (excluding own and already applied)
        const openJobs = await prisma.job.findMany({
          where: {
            status: "OPEN",
            isFlagged: false,
            clientId: { not: userId },
            id: { notIn: appliedJobIds.length > 0 ? appliedJobIds : undefined },
          },
          include: {
            client: {
              select: {
                id: true,
                username: true,
                avatarUrl: true,
                walletAddress: true,
                reviewsReceived: { select: { rating: true } },
              },
            },
            freelancer: { select: { id: true, username: true, avatarUrl: true } },
            milestones: true,
            _count: { select: { applications: true } },
          },
        });

        // 6. Fetch on-chain reputation for all clients (in parallel)
        const clientAddresses = openJobs
          .map((job) => job.client.walletAddress)
          .filter(Boolean) as string[];

        const uniqueAddresses = [...new Set(clientAddresses)];

        const reputationMap: Map<string, OnChainReputation | null> = new Map();
        let isRpcFallback = false;

        try {
          const reputationPromises = uniqueAddresses.map(async (address) => {
            try {
              const rep = await ReputationCacheService.getCachedReputation(address);
              return { address, rep };
            } catch {
              logger.debug({ address }, "Failed to fetch reputation for client");
              return { address, rep: null };
            }
          });

          const results = await Promise.allSettled(reputationPromises);

          results.forEach((result) => {
            if (result.status === "fulfilled" && result.value) {
              reputationMap.set(result.value.address, result.value.rep);
            }
          });
        } catch (error) {
          logger.warn(
            { err: error },
            "Failed to fetch on-chain reputations - using neutral fallback"
          );
          isRpcFallback = true;
        }

        // 7. Score and deterministically sort with tie-breaking
        const now = new Date();
        const scoredJobs = openJobs.map((job) => {
          const clientReviews = job.client.reviewsReceived || [];
          const clientAvgRating =
            clientReviews.length > 0
              ? clientReviews.reduce((sum, r) => sum + r.rating, 0) /
                clientReviews.length
              : 0;

          const clientReputation = job.client.walletAddress
            ? reputationMap.get(job.client.walletAddress) ?? null
            : null;

          const relevanceScore = computeRelevanceScore({
            freelancerSkills: user.skills,
            jobSkills: job.skills,
            jobCategory: job.category,
            completedCategories,
            jobCreatedAt: job.createdAt,
            clientAverageRating: clientAvgRating,
            onChainReputation: clientReputation,
            completedJobsCount,
            totalJobsCount,
            isRpcFallback,
            now,
          });

          // Strip reviewsReceived/walletAddress from client in the response
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { reviewsReceived, walletAddress, ...clientData } = job.client;

          return {
            ...job,
            client: clientData,
            relevanceScore: Math.round(relevanceScore * 1000) / 1000,
          };
        });

        scoredJobs.sort(compareRecommendedJobs);

        return {
          snapshotId: activeSnapshotId,
          createdAtMs: Date.now(),
          items: scoredJobs,
        };
      }
    );

    if (!snapshot) {
      return null;
    }

    memorySnapshots.set(`${userId}:${snapshot.snapshotId}`, snapshot);

    return RecommendationService.paginateSnapshot(
      snapshot,
      page,
      limit,
      decodedCursor
    );
  }

  private static paginateSnapshot(
    snapshot: RecommendationSnapshot,
    page: number,
    limit: number,
    decodedCursor: RecommendationCursorPayload | null
  ) {
    const allItems = snapshot.items;
    const total = allItems.length;

    let startIndex = (page - 1) * limit;
    if (decodedCursor) {
      const exactIdx = allItems.findIndex((item) => item.id === decodedCursor.id);
      if (exactIdx !== -1) {
        startIndex = exactIdx + 1;
      } else {
        // Keyset fallback if snapshot was rebuilt after cursor creation:
        // seek to the first item strictly after the cursor in deterministic sort order.
        const cursorAnchor = {
          relevanceScore: decodedCursor.score,
          createdAt: decodedCursor.createdAt,
          id: decodedCursor.id,
        };
        const afterIdx = allItems.findIndex(
          (item) => compareRecommendedJobs(item, cursorAnchor) > 0
        );
        startIndex = afterIdx === -1 ? total : afterIdx;
      }
    }

    const paginatedJobs = allItems.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + paginatedJobs.length < total;
    const lastItem =
      paginatedJobs.length > 0 ? paginatedJobs[paginatedJobs.length - 1] : null;

    const nextCursor =
      hasMore && lastItem
        ? encodeRecommendationCursor({
            score: lastItem.relevanceScore,
            createdAt: new Date(lastItem.createdAt).toISOString(),
            id: String(lastItem.id),
            snapshotId: snapshot.snapshotId,
          })
        : null;

    const effectivePage = decodedCursor
      ? Math.floor(startIndex / limit) + 1
      : page;

    return {
      data: paginatedJobs,
      total,
      page: effectivePage,
      totalPages: Math.ceil(total / limit),
      snapshotId: snapshot.snapshotId,
      nextCursor,
    };
  }

  static async rebuildRecommendationsForJob(jobId: string): Promise<void> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { id: true, status: true, deletedAt: true },
    });

    memorySnapshots.clear();
    for (const [uid, gen] of userSnapshotGeneration.entries()) {
      userSnapshotGeneration.set(uid, gen + 1);
    }

    if (!job || job.deletedAt || job.status !== "OPEN") {
      await invalidateCache("recommendations:*");
      return;
    }

    await invalidateCache("recommendations:*");

    const freelancers = await prisma.user.findMany({
      where: {
        role: "FREELANCER",
        emailVerified: true,
      },
      select: { id: true },
    });

    for (const freelancer of freelancers) {
      await RecommendationService.getRecommendedJobs(freelancer.id, 1, 10);
    }
  }

  /**
   * Invalidate recommendation cache for a user when they apply to a job
   */
  static async invalidateUserRecommendations(userId: string) {
    for (const key of memorySnapshots.keys()) {
      if (key.startsWith(`${userId}:`)) {
        memorySnapshots.delete(key);
      }
    }
    userSnapshotGeneration.set(
      userId,
      (userSnapshotGeneration.get(userId) ?? 1) + 1
    );
    await invalidateCache(`recommendations:${userId}:*`);
  }
}
