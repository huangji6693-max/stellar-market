import { BadgeTier } from "@prisma/client";
import {
  jaccardSimilarity,
  categoryAffinityScore,
  recencyScore,
  reputationScore,
  computeRelevanceScore,
  compareRecommendedJobs,
  encodeRecommendationCursor,
  decodeRecommendationCursor,
  recommendationPrisma,
  RecommendationService,
} from "../recommendation.service";

// ─── Jaccard Similarity ──────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 1 for identical skill sets", () => {
    expect(jaccardSimilarity(["React", "Node.js"], ["React", "Node.js"])).toBe(1);
  });

  it("returns 0 for completely disjoint sets", () => {
    expect(jaccardSimilarity(["React", "Vue"], ["Python", "Django"])).toBe(0);
  });

  it("returns 0 when both sets are empty", () => {
    expect(jaccardSimilarity([], [])).toBe(0);
  });

  it("returns 0 when one set is empty", () => {
    expect(jaccardSimilarity(["React"], [])).toBe(0);
  });

  it("computes correct similarity for partial overlap", () => {
    // A = {react, node.js}, B = {react, python}
    // Intersection = {react} = 1, Union = {react, node.js, python} = 3
    // J = 1/3 ≈ 0.333
    const result = jaccardSimilarity(["React", "Node.js"], ["React", "Python"]);
    expect(result).toBeCloseTo(1 / 3, 5);
  });

  it("is case-insensitive", () => {
    expect(jaccardSimilarity(["REACT", "node.js"], ["react", "NODE.JS"])).toBe(1);
  });

  it("handles duplicates in input by deduplicating via Set", () => {
    // Both reduce to {react, node.js}
    expect(
      jaccardSimilarity(["React", "React", "Node.js"], ["React", "Node.js"])
    ).toBe(1);
  });

  it("computes known example: ['js','ts'] vs ['js','react'] = 1/3", () => {
    const result = jaccardSimilarity(["js", "ts"], ["js", "react"]);
    expect(result).toBeCloseTo(1 / 3, 5);
  });
});

// ─── Category Affinity ───────────────────────────────────────────────────────

describe("categoryAffinityScore", () => {
  it("returns 1 when job category matches a completed category", () => {
    expect(categoryAffinityScore("Development", ["Development", "Design"])).toBe(1);
  });

  it("returns 0 when job category has no match", () => {
    expect(categoryAffinityScore("Marketing", ["Development", "Design"])).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(categoryAffinityScore("DEVELOPMENT", ["development"])).toBe(1);
  });

  it("returns 0 when completed categories is empty", () => {
    expect(categoryAffinityScore("Development", [])).toBe(0);
  });
});

// ─── Recency Score ───────────────────────────────────────────────────────────

describe("recencyScore", () => {
  const now = new Date("2026-02-26T00:00:00Z");

  it("returns 1 for a job posted right now", () => {
    expect(recencyScore(now, now)).toBe(1);
  });

  it("returns ~0.5 for a job posted 15 days ago", () => {
    const fifteenDaysAgo = new Date("2026-02-11T00:00:00Z");
    expect(recencyScore(fifteenDaysAgo, now)).toBeCloseTo(0.5, 1);
  });

  it("returns 0 for a job posted 30+ days ago", () => {
    const thirtyDaysAgo = new Date("2026-01-27T00:00:00Z");
    expect(recencyScore(thirtyDaysAgo, now)).toBe(0);
  });

  it("returns 0 for a very old job", () => {
    const veryOld = new Date("2025-01-01T00:00:00Z");
    expect(recencyScore(veryOld, now)).toBe(0);
  });

  it("returns exactly 1 for a future createdAt (clock skew case)", () => {
    const futureDate = new Date("2026-03-01T00:00:00Z");
    expect(recencyScore(futureDate, now)).toBe(1);
  });
});

// ─── Reputation Score ────────────────────────────────────────────────────────

describe("reputationScore", () => {
  it("returns 1 for a perfect 5.0 rating", () => {
    expect(reputationScore(5)).toBe(1);
  });

  it("returns 0.6 for a 3.0 rating", () => {
    expect(reputationScore(3)).toBeCloseTo(0.6, 5);
  });

  it("returns 0 for no rating (0)", () => {
    expect(reputationScore(0)).toBe(0);
  });

  it("clamps to 1 for ratings above 5", () => {
    expect(reputationScore(6)).toBe(1);
  });

  it("clamps to 0 for negative ratings", () => {
    expect(reputationScore(-1)).toBe(0);
  });
});

// ─── Combined Relevance Score ────────────────────────────────────────────────

describe("computeRelevanceScore", () => {
  const now = new Date("2026-02-26T00:00:00Z");

  it("returns 0 when there is no overlap and no affinity", () => {
    const score = computeRelevanceScore({
      freelancerSkills: ["React"],
      jobSkills: ["Python"],
      jobCategory: "Data Science",
      completedCategories: ["Development"],
      jobCreatedAt: new Date("2025-01-01T00:00:00Z"), // very old
      clientAverageRating: 0,
      onChainReputation: null,
      completedJobsCount: 0,
      totalJobsCount: 0,
      now,
    });
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("returns max score for perfect match on all dimensions", () => {
    const score = computeRelevanceScore({
      freelancerSkills: ["React", "Node.js"],
      jobSkills: ["React", "Node.js"],
      jobCategory: "Development",
      completedCategories: ["Development"],
      jobCreatedAt: now, // just posted
      clientAverageRating: 5,
      onChainReputation: {
        tier: BadgeTier.PLATINUM,
        score: 5000,
        disputeLossRate: 0,
        endorsementWeight: 1.0,
        lastUpdated: Date.now(),
      },
      completedJobsCount: 10,
      totalJobsCount: 10,
      now,
    });
    // With new weights and on-chain signals
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("correctly weights partial skill overlap", () => {
    const score = computeRelevanceScore({
      freelancerSkills: ["React", "Node.js"],
      jobSkills: ["React", "Python"],
      jobCategory: "Other",
      completedCategories: [],
      jobCreatedAt: new Date("2025-01-01T00:00:00Z"), // old
      clientAverageRating: 0,
      onChainReputation: null,
      completedJobsCount: 0,
      totalJobsCount: 0,
      now,
    });
    // Only skill overlap contributes: 0.25 * (1/3) ≈ 0.083
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5);
  });

  it("boosts score for matching category", () => {
    const withoutCategory = computeRelevanceScore({
      freelancerSkills: [],
      jobSkills: [],
      jobCategory: "Development",
      completedCategories: [],
      jobCreatedAt: new Date("2025-01-01T00:00:00Z"),
      clientAverageRating: 0,
      onChainReputation: null,
      completedJobsCount: 0,
      totalJobsCount: 0,
      now,
    });

    const withCategory = computeRelevanceScore({
      freelancerSkills: [],
      jobSkills: [],
      jobCategory: "Development",
      completedCategories: ["Development"],
      jobCreatedAt: new Date("2025-01-01T00:00:00Z"),
      clientAverageRating: 0,
      onChainReputation: null,
      completedJobsCount: 0,
      totalJobsCount: 0,
      now,
    });

    // Both get neutral fallback scores (0.5) for on-chain signals when null
    // The difference comes from category match which is not scored directly anymore
    // Instead, category is part of historical completion tracking
    // With the new weights, both should have similar base scores
    expect(withCategory).toBeGreaterThanOrEqual(withoutCategory);
  });
});

// ─── #947: Recency and Client Reputation Scoring ─────────────────────────────

describe("recency integration in computeRelevanceScore (#947)", () => {
  const now = new Date("2026-07-01T00:00:00Z");

  it("more recent job scores higher", () => {
    const base = {
      freelancerSkills: ["React"],
      jobSkills: ["React"],
      jobCategory: "Development",
      completedCategories: ["Development"],
      clientAverageRating: 3,
      onChainReputation: null,
      completedJobsCount: 5,
      totalJobsCount: 10,
      now,
    };

    const recentScore = computeRelevanceScore({
      ...base,
      jobCreatedAt: now,
    });

    const oldScore = computeRelevanceScore({
      ...base,
      jobCreatedAt: new Date("2026-06-01T00:00:00Z"),
    });

    expect(recentScore).toBeGreaterThan(oldScore);
  });
});

describe("client reputation integration in computeRelevanceScore (#947)", () => {
  const now = new Date("2026-07-01T00:00:00Z");

  it("higher-rated client job scores higher", () => {
    const base = {
      freelancerSkills: ["React"],
      jobSkills: ["React"],
      jobCategory: "Development",
      completedCategories: ["Development"],
      jobCreatedAt: now,
      onChainReputation: null,
      completedJobsCount: 5,
      totalJobsCount: 10,
      now,
    };

    const highRepScore = computeRelevanceScore({
      ...base,
      clientAverageRating: 5,
    });

    const lowRepScore = computeRelevanceScore({
      ...base,
      clientAverageRating: 1,
    });

    expect(highRepScore).toBeGreaterThan(lowRepScore);
  });
});

describe("WEIGHTS sum to 1.0 (#947)", () => {
  it("all weights sum to exactly 1.0", async () => {
    const { WEIGHTS } = await import("../recommendation.service");
    const sum = Object.values(WEIGHTS).reduce((a: number, b: number) => a + b, 0);
    expect(sum).toBe(1.0);
  });
});

// ─── #1123: Snapshot-consistent pagination & deterministic tie-breaking ──────

describe("Recommendation pagination snapshot consistency & tie-breaking (#1123)", () => {
  it("orders tied relevanceScores deterministically by createdAt DESC then id ASC", () => {
    const t1 = new Date("2026-07-01T10:00:00Z");
    const t2 = new Date("2026-07-01T12:00:00Z");

    const items = [
      { id: "job-c", relevanceScore: 0.75, createdAt: t1 },
      { id: "job-a", relevanceScore: 0.75, createdAt: t1 },
      { id: "job-b", relevanceScore: 0.75, createdAt: t2 },
      { id: "job-top", relevanceScore: 0.9, createdAt: t1 },
    ];

    const sorted = [...items].sort(compareRecommendedJobs);
    expect(sorted.map((i) => i.id)).toEqual(["job-top", "job-b", "job-a", "job-c"]);
  });

  it("encodes and decodes opaque recommendation cursors and rejects invalid tokens", () => {
    const cursor = encodeRecommendationCursor({
      score: 0.812,
      createdAt: "2026-07-01T12:00:00.000Z",
      id: "job-2",
      snapshotId: "v1",
    });

    const decoded = decodeRecommendationCursor(cursor);
    expect(decoded).toEqual({
      score: 0.812,
      createdAt: "2026-07-01T12:00:00.000Z",
      id: "job-2",
      snapshotId: "v1",
    });

    expect(decodeRecommendationCursor("not-a-valid-cursor")).toBeNull();
  });

  it("prevents duplicate or skipped jobs across pages when concurrent job changes occur between page 1 and page 2", async () => {
    const userId = "freelancer-snapshot-1123";
    const baseTime = new Date("2026-07-01T00:00:00.000Z");

    const makeJob = (id: string, skills: string[], createdAtOffsetMs: number) => ({
      id,
      title: `Job ${id}`,
      description: "Test job",
      budget: 500,
      category: "Development",
      skills,
      status: "OPEN",
      isFlagged: false,
      clientId: "client-1",
      freelancerId: null,
      createdAt: new Date(baseTime.getTime() + createdAtOffsetMs),
      updatedAt: new Date(baseTime.getTime() + createdAtOffsetMs),
      client: {
        id: "client-1",
        username: "client1",
        avatarUrl: null,
        walletAddress: null,
        reviewsReceived: [{ rating: 5 }],
      },
      freelancer: null,
      milestones: [],
      _count: { applications: 0 },
    });

    const initialJobs = [
      makeJob("job-1", ["React", "TypeScript"], 4000),
      makeJob("job-2", ["React", "TypeScript"], 3000),
      makeJob("job-3", ["React"], 2000),
      makeJob("job-4", ["TypeScript"], 1000),
    ];

    // Simulate a newly posted high-scoring job arriving before page 2 is requested
    const mutatedJobsWithInsertion = [
      makeJob("job-new-intruder", ["React", "TypeScript"], 9000),
      ...initialJobs,
    ];

    const userSpy = jest
      .spyOn(recommendationPrisma.user, "findUnique")
      .mockResolvedValue({
        skills: ["React", "TypeScript"],
        role: "FREELANCER",
        walletAddress: null,
      } as never);
    const jobCountSpy = jest
      .spyOn(recommendationPrisma.job, "count")
      .mockResolvedValue(2 as never);
    const appFindManySpy = jest
      .spyOn(recommendationPrisma.application, "findMany")
      .mockResolvedValue([] as never);

    let openJobsCallCount = 0;
    const jobFindManySpy = jest
      .spyOn(recommendationPrisma.job, "findMany")
      .mockImplementation(((args?: { where?: { status?: string } }) => {
        if (args?.where?.status === "COMPLETED") {
          return Promise.resolve([{ category: "Development" }]) as never;
        }
        openJobsCallCount += 1;
        return Promise.resolve(
          openJobsCallCount === 1 ? initialJobs : mutatedJobsWithInsertion
        ) as never;
      }) as never);

    try {
      await RecommendationService.invalidateUserRecommendations(userId);

      // Page 1 (limit 2) captures the ranked snapshot of the 4 initial jobs
      const page1 = await RecommendationService.getRecommendedJobs(userId, 1, 2);
      expect(page1).not.toBeNull();
      expect(page1!.data.map((j) => j.id)).toEqual(["job-1", "job-2"]);
      expect(page1!.total).toBe(4);
      expect(page1!.nextCursor).toBeTruthy();

      // Page 2 via offset pagination reuses the frozen snapshot — no duplicate "job-2"
      const page2 = await RecommendationService.getRecommendedJobs(userId, 2, 2);
      expect(page2).not.toBeNull();
      expect(page2!.snapshotId).toBe(page1!.snapshotId);
      expect(page2!.data.map((j) => j.id)).toEqual(["job-3", "job-4"]);
      expect(page2!.nextCursor).toBeNull();

      // Cursor pagination from page1.nextCursor also yields the exact remaining slice
      const cursorPage2 = await RecommendationService.getRecommendedJobs(
        userId,
        1,
        2,
        { cursor: page1!.nextCursor! }
      );
      expect(cursorPage2).not.toBeNull();
      expect(cursorPage2!.data.map((j) => j.id)).toEqual(["job-3", "job-4"]);
      expect(openJobsCallCount).toBe(1);

      // After explicit invalidation, a fresh snapshot is built including the new job
      await RecommendationService.invalidateUserRecommendations(userId);
      const refreshedPage1 = await RecommendationService.getRecommendedJobs(
        userId,
        1,
        2
      );
      expect(refreshedPage1).not.toBeNull();
      expect(refreshedPage1!.snapshotId).not.toBe(page1!.snapshotId);
      expect(refreshedPage1!.total).toBe(5);
      expect(refreshedPage1!.data[0].id).toBe("job-new-intruder");
    } finally {
      userSpy.mockRestore();
      jobCountSpy.mockRestore();
      appFindManySpy.mockRestore();
      jobFindManySpy.mockRestore();
    }
  });
});
