import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import {
  encodeCursor,
  decodeCursor,
  buildCursorWhereClause,
  clampCursorLimit,
  OFFSET_DEPRECATION_WARNING,
} from "../../utils/cursorPagination";

import { config } from "../../config";

const USER_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000202";
const JWT_SECRET = config.jwtSecret;

const jobMock = {
  findMany: jest.fn<any>(),
  findUnique: jest.fn<any>(),
  count: jest.fn<any>(),
};

const userMock = {
  findUnique: jest.fn<any>(),
  findMany: jest.fn<any>(),
  count: jest.fn<any>(),
};

const messageMock = {
  findMany: jest.fn<any>(),
  count: jest.fn<any>(),
  updateMany: jest.fn<any>(),
};

const notificationMock = {
  findMany: jest.fn<any>(),
  count: jest.fn<any>(),
};

const prismaMock = {
  job: jobMock,
  user: userMock,
  message: messageMock,
  notification: notificationMock,
  $queryRaw: jest.fn<any>(),
  $transaction: jest.fn<any>((fn: any) =>
    typeof fn === "function" ? fn(prismaMock) : Promise.all(fn),
  ),
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => prismaMock),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (parts: unknown[], sep: string) => ({ parts, sep }),
  },
  JobStatus: {
    OPEN: "OPEN",
    IN_PROGRESS: "IN_PROGRESS",
    COMPLETED: "COMPLETED",
    CANCELLED: "CANCELLED",
  },
  NotificationType: {
    NEW_MESSAGE: "NEW_MESSAGE",
  },
}));

const loggerWarnMock = jest.fn();
jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../lib/cache", () => ({
  cache: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<any>) => ({
    data: await fn(),
    hit: false,
  })),
  invalidateCache: jest.fn(),
  invalidateCacheKey: jest.fn(),
  generateJobsCacheKey: jest.fn(() => "jobs:test"),
  generateJobCacheKey: jest.fn(() => "job:test"),
  generateJobOnChainStatusCacheKey: jest.fn(() => "job:onchain:test"),
}));

jest.mock("../../lib/notification-queue", () => ({
  notificationQueue: { add: jest.fn() },
  getNotificationPriority: jest.fn(() => 2),
}));

import jobRouter from "../job.routes";
import freelancerRouter from "../freelancer.routes";
import messageRouter from "../message.routes";
import notificationRouter from "../notification.routes";

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/jobs", jobRouter);
  app.use("/api/freelancers", freelancerRouter);
  app.use("/api/messages", messageRouter);
  app.use("/api/notifications", notificationRouter);
  return app;
}

function authHeader(userId = USER_ID) {
  const token = jwt.sign({ userId, role: "FREELANCER" }, JWT_SECRET, {
    expiresIn: "1h",
  });
  return { Authorization: `Bearer ${token}` };
}

describe("Cursor Pagination (#622)", () => {
  const app = createTestApp();

  beforeEach(() => {
    jest.clearAllMocks();
    userMock.findUnique.mockResolvedValue({
      id: USER_ID,
      role: "FREELANCER",
      emailVerified: true,
      tokenVersion: 0,
      isSuspended: false,
    });
  });

  describe("cursorPagination utilities", () => {
    it("encodes and decodes base64 cursor (id + createdAt) losslessly", () => {
      const createdAt = new Date("2026-03-15T12:00:00.000Z");
      const cursor = encodeCursor({ id: "job-42", createdAt });
      const decoded = decodeCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded?.id).toBe("job-42");
      expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString());
    });

    it("returns null for malformed cursor strings", () => {
      expect(decodeCursor("not-valid-base64-json")).toBeNull();
      expect(decodeCursor(undefined)).toBeNull();
    });

    it("clamps limit to max 50", () => {
      expect(clampCursorLimit(500)).toBe(50);
      expect(clampCursorLimit(0)).toBe(20);
      expect(clampCursorLimit(15)).toBe(15);
    });

    it("builds keyset WHERE filter for index seek on (createdAt, id)", () => {
      const d = new Date("2026-03-15T12:00:00.000Z");
      const clause = buildCursorWhereClause({ id: "item-5", createdAt: d }, "desc");
      expect(clause).toEqual({
        OR: [
          { createdAt: { lt: d } },
          { AND: [{ createdAt: d }, { id: { lt: "item-5" } }] },
        ],
      });
    });
  });

  describe("GET /api/jobs cursor pagination", () => {
    const sampleJobs = [
      {
        id: "job-3",
        title: "Smart Contract Audit",
        description: "Audit Soroban contracts for security vulnerabilities",
        budget: 1000,
        category: "Smart Contract",
        status: "OPEN",
        skills: ["Rust"],
        deadline: new Date("2026-06-01T00:00:00.000Z"),
        escrowStatus: "UNFUNDED",
        clientId: OTHER_USER_ID,
        freelancerId: null,
        createdAt: new Date("2026-03-03T10:00:00.000Z"),
        updatedAt: new Date("2026-03-03T10:00:00.000Z"),
        client: { id: OTHER_USER_ID, username: "alice", avatarUrl: null, walletAddress: null },
        freelancer: null,
        _count: { applications: 0 },
      },
      {
        id: "job-2",
        title: "Frontend Dashboard",
        description: "Build analytics dashboard for Stellar payments",
        budget: 750,
        category: "Frontend",
        status: "OPEN",
        skills: ["React"],
        deadline: new Date("2026-06-01T00:00:00.000Z"),
        escrowStatus: "UNFUNDED",
        clientId: OTHER_USER_ID,
        freelancerId: null,
        createdAt: new Date("2026-03-02T10:00:00.000Z"),
        updatedAt: new Date("2026-03-02T10:00:00.000Z"),
        client: { id: OTHER_USER_ID, username: "alice", avatarUrl: null, walletAddress: null },
        freelancer: null,
        _count: { applications: 0 },
      },
      {
        id: "job-1",
        title: "Indexer Integration",
        description: "Build Horizon event listener for escrow updates",
        budget: 500,
        category: "Backend",
        status: "OPEN",
        skills: ["Node.js"],
        deadline: new Date("2026-06-01T00:00:00.000Z"),
        escrowStatus: "UNFUNDED",
        clientId: OTHER_USER_ID,
        freelancerId: null,
        createdAt: new Date("2026-03-01T10:00:00.000Z"),
        updatedAt: new Date("2026-03-01T10:00:00.000Z"),
        client: { id: OTHER_USER_ID, username: "alice", avatarUrl: null, walletAddress: null },
        freelancer: null,
        _count: { applications: 0 },
      },
    ];

    it("fetches consecutive pages using nextCursor with no duplicates even with concurrent inserts", async () => {
      const startCursor = encodeCursor({
        id: "job-999",
        createdAt: new Date("2026-03-04T10:00:00.000Z"),
      });

      // Page 1: limit=2 returns 3 rows from DB (take: limit + 1) -> slices to 2, hasMore=true
      jobMock.findMany.mockResolvedValueOnce(sampleJobs.slice(0, 3));
      jobMock.count.mockResolvedValueOnce(3);

      const page1 = await request(app).get(
        `/api/jobs?cursor=${encodeURIComponent(startCursor)}&limit=2`,
      );
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.hasMore).toBe(true);
      expect(typeof page1.body.nextCursor).toBe("string");

      // Concurrent insert happens at top of list (job-1000 at 2026-03-05),
      // but Page 2 uses page1.body.nextCursor (anchored at job-2) so no duplicates occur
      jobMock.findMany.mockResolvedValueOnce([sampleJobs[2]]);
      jobMock.count.mockResolvedValueOnce(4);

      const page2 = await request(app).get(
        `/api/jobs?cursor=${encodeURIComponent(page1.body.nextCursor)}&limit=2`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).toBe("job-1");
      expect(page2.body.hasMore).toBe(false);
      expect(page2.body.nextCursor).toBeNull();

      const seenIds = [
        ...page1.body.data.map((j: any) => j.id),
        ...page2.body.data.map((j: any) => j.id),
      ];
      expect(new Set(seenIds).size).toBe(seenIds.length);
    });

    it("falls back to offset pagination when ?page= is passed and logs deprecation warning", async () => {
      jobMock.findMany.mockResolvedValueOnce([sampleJobs[0]]);
      jobMock.count.mockResolvedValueOnce(1);

      const res = await request(app).get("/api/jobs?page=1&limit=10");
      expect(res.status).toBe(200);
      expect(res.body.deprecationWarning).toBe(OFFSET_DEPRECATION_WARNING);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "GET /jobs", page: 1 }),
        OFFSET_DEPRECATION_WARNING,
      );
    });
  });

  describe("GET /api/freelancers cursor pagination", () => {
    it("returns { data, nextCursor, hasMore } and sets hasMore: false on last page", async () => {
      userMock.findMany.mockResolvedValueOnce([
        {
          id: "fl-2",
          username: "dev2",
          avatarUrl: null,
          bio: "Rust dev",
          skills: ["Rust"],
          availability: true,
          averageRating: 4.9,
          reviewCount: 10,
          walletAddress: null,
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
        },
        {
          id: "fl-1",
          username: "dev1",
          avatarUrl: null,
          bio: "TS dev",
          skills: ["TypeScript"],
          availability: true,
          averageRating: 4.8,
          reviewCount: 5,
          walletAddress: null,
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);

      const page1 = await request(app).get("/api/freelancers?limit=1");
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.nextCursor).toBeTruthy();

      userMock.findMany.mockResolvedValueOnce([
        {
          id: "fl-1",
          username: "dev1",
          avatarUrl: null,
          bio: "TS dev",
          skills: ["TypeScript"],
          availability: true,
          averageRating: 4.8,
          reviewCount: 5,
          walletAddress: null,
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);

      const page2 = await request(app).get(
        `/api/freelancers?cursor=${encodeURIComponent(page1.body.nextCursor)}&limit=1`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.hasMore).toBe(false);
      expect(page2.body.nextCursor).toBeNull();
    });
  });

  describe("GET /api/messages/:conversationId cursor pagination", () => {
    it("supports cursor pagination and logs warning on ?page= fallback", async () => {
      messageMock.findMany.mockResolvedValueOnce([
        {
          id: "msg-1",
          senderId: OTHER_USER_ID,
          receiverId: USER_ID,
          content: "First",
          read: false,
          createdAt: new Date("2026-03-01T10:00:00.000Z"),
          sender: { id: OTHER_USER_ID, username: "bob", avatarUrl: null },
        },
      ]);
      messageMock.count.mockResolvedValueOnce(1);
      messageMock.updateMany.mockResolvedValueOnce({ count: 1 });

      const cursorRes = await request(app)
        .get(`/api/messages/${OTHER_USER_ID}?limit=10`)
        .set(authHeader());
      expect(cursorRes.status).toBe(200);
      expect(cursorRes.body.data).toHaveLength(1);
      expect(cursorRes.body.hasMore).toBe(false);
      expect(cursorRes.body.nextCursor).toBeNull();

      messageMock.findMany.mockResolvedValueOnce([]);
      messageMock.count.mockResolvedValueOnce(0);
      messageMock.updateMany.mockResolvedValueOnce({ count: 0 });

      const offsetRes = await request(app)
        .get(`/api/messages/${OTHER_USER_ID}?page=1&limit=10`)
        .set(authHeader());
      expect(offsetRes.status).toBe(200);
      expect(offsetRes.body.deprecationWarning).toBe(OFFSET_DEPRECATION_WARNING);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "GET /messages/:conversationId", page: 1 }),
        OFFSET_DEPRECATION_WARNING,
      );
    });
  });

  describe("GET /api/notifications cursor pagination", () => {
    it("paginates notifications with cursor and logs deprecation warning when ?page= is used", async () => {
      notificationMock.findMany.mockResolvedValueOnce([
        {
          id: "notif-2",
          userId: USER_ID,
          type: "NEW_MESSAGE",
          title: "Msg 2",
          message: "Hello 2",
          read: false,
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
        },
        {
          id: "notif-1",
          userId: USER_ID,
          type: "NEW_MESSAGE",
          title: "Msg 1",
          message: "Hello 1",
          read: false,
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ]);
      notificationMock.count.mockResolvedValueOnce(2);

      const page1 = await request(app)
        .get("/api/notifications?limit=1")
        .set(authHeader());
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.hasMore).toBe(true);
      expect(page1.body.nextCursor).toBeTruthy();

      notificationMock.findMany.mockResolvedValueOnce([]);
      notificationMock.count.mockResolvedValueOnce(2);

      const offsetRes = await request(app)
        .get("/api/notifications?page=1&limit=10")
        .set(authHeader());
      expect(offsetRes.status).toBe(200);
      expect(offsetRes.body.deprecationWarning).toBe(OFFSET_DEPRECATION_WARNING);
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "GET /notifications", page: 1 }),
        OFFSET_DEPRECATION_WARNING,
      );
    });
  });
});
