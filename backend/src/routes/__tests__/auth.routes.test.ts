import request from "supertest";
import express from "express";
import { Request, Response, NextFunction } from "express";

// ─── ESM module mocks ────────────────────────────────────────────────────────
jest.mock("otplib", () => ({
  generateSecret: jest.fn(() => "mock-secret"),
  generateSync: jest.fn(() => "123456"),
  verifySync: jest.fn(() => ({ valid: true, delta: 0 })),
  generateURI: jest.fn(() => "otpauth://mock"),
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqr"),
}));

const redisStore = new Map<string, string>();
const mockRedis = {
  get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
  set: jest.fn(async (key: string, val: string) => {
    redisStore.set(key, val);
    return "OK";
  }),
  del: jest.fn(async (key: string) => {
    redisStore.delete(key);
    return 1;
  }),
};

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {
    getInstance: jest.fn(() => mockRedis),
  },
}));

jest.mock("../../lib/token-version", () => ({
  invalidateTokenVersionCache: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

interface AuthRequest extends Request {
  userId?: string;
}

jest.mock("../../middleware/auth", () => ({
  authenticate: (req: AuthRequest, res: Response, next: NextFunction) => {
    req.userId = "test-user-id";
    next();
  },
}));

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("new-hashed-password"),
  compare: jest.fn().mockResolvedValue(true),
}));

import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import authRoutes, { REFRESH_BLACKLIST_KEY, REFRESH_USER_KEY } from "../auth.routes";
import { errorHandler } from "../../middleware/error";
import { hashToken } from "../../utils/token";
import { config } from "../../config";

const prismaMock = new PrismaClient() as jest.Mocked<PrismaClient>;
const userMock = prismaMock.user as unknown as {
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
};
const refreshTokenMock = prismaMock.refreshToken as unknown as {
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  create: jest.Mock;
};

describe("Auth Routes - Password Reset / Change & Refresh Token Rotation (#619)", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);

  afterEach(() => {
    jest.clearAllMocks();
    redisStore.clear();
  });

  it("POST /reset-password should revoke refresh tokens", async () => {
    userMock.findFirst.mockResolvedValue({ id: "test-user-id" });
    userMock.update.mockResolvedValue({ id: "test-user-id" });
    refreshTokenMock.updateMany.mockResolvedValue({ count: 1 });

    const response = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "some-token", password: "NewPassword123" });

    expect(response.status).toBe(200);
    expect(refreshTokenMock.updateMany).toHaveBeenCalledWith({
      where: { userId: "test-user-id" },
      data: { revoked: true },
    });
  });

  it("POST /change-password should revoke refresh tokens", async () => {
    userMock.findUnique.mockResolvedValue({
      id: "test-user-id",
      password: "old-hashed-password",
    });
    userMock.update.mockResolvedValue({
      id: "test-user-id",
      tokenVersion: 2,
    });
    refreshTokenMock.updateMany.mockResolvedValue({ count: 1 });

    const response = await request(app)
      .post("/api/auth/change-password")
      .send({ currentPassword: "OldPassword123", newPassword: "NewPassword123" });

    expect(response.status).toBe(200);
    expect(refreshTokenMock.updateMany).toHaveBeenCalledWith({
      where: { userId: "test-user-id" },
      data: { revoked: true },
    });
  });

  it("POST /refresh rotates refresh token, sets 15m access token TTL, and blacklists old token in Redis", async () => {
    const oldRaw = "raw-refresh-token-1";
    const oldHash = hashToken(oldRaw);

    refreshTokenMock.findUnique.mockResolvedValueOnce({
      tokenHash: oldHash,
      userId: "user-1",
      revoked: false,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    userMock.findUnique.mockResolvedValueOnce({
      id: "user-1",
      isSuspended: false,
      tokenVersion: 1,
    });
    refreshTokenMock.update.mockResolvedValueOnce({ tokenHash: oldHash, revoked: true });
    refreshTokenMock.create.mockResolvedValueOnce({});

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${oldRaw}`);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    // Verify 15-minute access token TTL (900 seconds)
    const decoded = jwt.verify(res.body.token, config.jwtSecret) as {
      userId: string;
      iat: number;
      exp: number;
    };
    expect(decoded.userId).toBe("user-1");
    expect(decoded.exp - decoded.iat).toBe(15 * 60);

    // Old token blacklisted as rotated in Redis; new refresh token stored under user key
    expect(redisStore.get(REFRESH_BLACKLIST_KEY(oldHash))).toBe("rotated:user-1");
    expect(redisStore.get(REFRESH_USER_KEY("user-1"))).toBeDefined();
    expect(res.headers["set-cookie"]?.[0]).toContain("refreshToken=");
    expect(res.headers["set-cookie"]?.[0]).not.toContain(oldRaw);
  });

  it("POST /refresh detects rotated refresh token reuse, revokes all sessions, and returns 401", async () => {
    const reusedRaw = "reused-refresh-token";
    const reusedHash = hashToken(reusedRaw);
    redisStore.set(REFRESH_BLACKLIST_KEY(reusedHash), "rotated:user-1");
    redisStore.set(REFRESH_USER_KEY("user-1"), "active-hash");

    refreshTokenMock.findUnique.mockResolvedValueOnce({
      tokenHash: reusedHash,
      userId: "user-1",
      revoked: true,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    refreshTokenMock.updateMany.mockResolvedValueOnce({ count: 2 });
    userMock.update.mockResolvedValueOnce({ id: "user-1", tokenVersion: 2 });

    const res = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${reusedRaw}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("reuse");
    expect(refreshTokenMock.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      data: { revoked: true },
    });
    expect(redisStore.get(REFRESH_USER_KEY("user-1"))).toBeUndefined();
  });

  it("POST /logout blacklists the current refresh token in Redis immediately", async () => {
    const rawToken = "logout-refresh-token";
    const tokenHash = hashToken(rawToken);
    redisStore.set(REFRESH_USER_KEY("user-1"), tokenHash);

    refreshTokenMock.update.mockResolvedValueOnce({
      tokenHash,
      userId: "user-1",
      revoked: true,
    });

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `refreshToken=${rawToken}`);

    expect(res.status).toBe(200);
    expect(redisStore.get(REFRESH_BLACKLIST_KEY(tokenHash))).toBe("logout");
    expect(redisStore.get(REFRESH_USER_KEY("user-1"))).toBeUndefined();

    // Presenting the logged-out token to /refresh returns 401
    refreshTokenMock.findUnique.mockResolvedValueOnce({
      tokenHash,
      userId: "user-1",
      revoked: true,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", `refreshToken=${rawToken}`);
    expect(refreshRes.status).toBe(401);
  });
});
