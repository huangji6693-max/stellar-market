import request from "supertest";
import express from "express";

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    job: { count: jest.fn().mockResolvedValue(3) },
    user: { count: jest.fn().mockResolvedValue(2) },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock("../../lib/cache", () => ({
  cache: jest.fn((_key: string, _ttl: number, fn: () => Promise<unknown>) =>
    fn().then((d) => ({ data: d, hit: false })),
  ),
  invalidateCache: jest.fn(),
  invalidateCacheKey: jest.fn(),
}));

import { PrismaClient } from "@prisma/client";
import categoryRouter from "../category.routes";
import { JOB_CATEGORIES } from "../../constants/categories";

const prismaMock = new PrismaClient() as unknown as {
  $queryRaw: jest.Mock;
};
const queryRawMock = prismaMock.$queryRaw;

const app = express();
app.use(express.json());
app.use("/categories", categoryRouter);

afterEach(() => jest.clearAllMocks());

describe("GET /categories — single grouped job-count query", () => {
  it("issues exactly one job-count query regardless of category count", async () => {
    await request(app).get("/categories").expect(200);

    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("maps grouped counts onto categories, defaulting missing entries to 0", async () => {
    queryRawMock.mockResolvedValueOnce([
      { category: "frontend", jobCount: 5 },
      { category: "backend", jobCount: 3 },
    ]);

    const res = await request(app).get("/categories").expect(200);

    const byName = Object.fromEntries(
      res.body.data.map((c: { name: string; jobCount: number }) => [c.name, c.jobCount]),
    );
    expect(byName.Frontend).toBe(5);
    expect(byName.Backend).toBe(3);
    expect(byName.Design).toBe(0);
    expect(byName.DevOps).toBe(0);
  });

  it("returns one entry per VALID_CATEGORY with slug, icon, and description", async () => {
    const res = await request(app).get("/categories").expect(200);

    expect(res.body.data).toHaveLength(JOB_CATEGORIES.length);
    for (const category of JOB_CATEGORIES) {
      const entry = res.body.data.find((c: { name: string }) => c.name === category);
      expect(entry).toBeDefined();
      expect(entry.slug).toBe(category.toLowerCase().replace(/\s+/g, "-"));
      expect(typeof entry.icon).toBe("string");
      expect(typeof entry.description).toBe("string");
    }
  });
});
