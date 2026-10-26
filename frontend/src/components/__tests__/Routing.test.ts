import { buildCspHeader, middleware } from "@/middleware";
import type { NextRequest } from "next/server";

// Mock next/server
jest.mock(
  "next/server",
  () => {
    return {
      NextResponse: {
        next: jest.fn().mockImplementation(() => ({ headers: new Map() })),
        redirect: jest.fn((url) => ({
          headers: new Map([["Location", url.toString()]]),
        })),
      },
    };
  },
  { virtual: true },
);

describe("Middleware Routing", () => {
  it("allows unauthenticated access to / without redirecting", () => {
    const req = {
      nextUrl: { pathname: "/" },
      cookies: { get: () => undefined },
      url: "http://localhost:3000/",
    } as unknown as NextRequest;
    
    const res = middleware(req);
    expect(res.headers.get("Location")).toBeUndefined();
  });

  it("allows authenticated access to / without redirecting", () => {
    const req = {
      nextUrl: { pathname: "/" },
      cookies: { get: () => ({ value: "fake-token" }) },
      url: "http://localhost:3000/",
    } as unknown as NextRequest;
    
    const res = middleware(req);
    expect(res.headers.get("Location")).toBeUndefined();
  });

  it("redirects unauthenticated users from /dashboard to /auth/login", () => {
    const req = {
      nextUrl: { pathname: "/dashboard" },
      cookies: { get: () => undefined },
      url: "http://localhost:3000/dashboard",
    } as unknown as NextRequest;
    
    const res = middleware(req);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/auth/login");
  });

  it("redirects authenticated users from /auth/login to /dashboard", () => {
    const req = {
      nextUrl: { pathname: "/auth/login" },
      cookies: { get: () => ({ value: "fake-token" }) },
      url: "http://localhost:3000/auth/login",
    } as unknown as NextRequest;
    
    const res = middleware(req);
    expect(res.headers.get("Location")).toBe("http://localhost:3000/dashboard");
  });

  it("sets Content-Security-Policy with per-request nonce and disallowing unsafe-inline in script-src (#822)", () => {
    const req1 = {
      nextUrl: { pathname: "/" },
      cookies: { get: () => undefined },
      url: "http://localhost:3000/",
    } as unknown as NextRequest;
    const req2 = {
      nextUrl: { pathname: "/" },
      cookies: { get: () => undefined },
      url: "http://localhost:3000/",
    } as unknown as NextRequest;

    const res1 = middleware(req1);
    const res2 = middleware(req2);

    const csp1 = res1.headers.get("Content-Security-Policy") ?? "";
    const csp2 = res2.headers.get("Content-Security-Policy") ?? "";

    expect(csp1).toContain("default-src 'self'");
    expect(csp1).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp1).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp1).toContain("frame-ancestors 'none'");
    expect(csp1).not.toBe(csp2);

    expect(res1.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res1.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("buildCspHeader constructs strict CSP policy with nonce and frame-ancestors 'none'", () => {
    const csp = buildCspHeader("test-nonce-123");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce-123'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
