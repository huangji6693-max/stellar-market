import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PROTECTED_ROUTES = ["/dashboard", "/post-job", "/messages", "/profile"];
const AUTH_ROUTES = ["/auth/login", "/auth/register"];

export function buildCspHeader(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://horizon-testnet.stellar.org https://horizon.stellar.org https://soroban-testnet.stellar.org wss:",
    "frame-ancestors 'none'",
  ].join("; ");
}

function applySecurityHeaders(
  response: NextResponse,
  cspHeader: string,
): NextResponse {
  response.headers.set("Content-Security-Policy", cspHeader);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function middleware(request: NextRequest) {
  const token = request.cookies.get("stellarmarket_jwt")?.value;
  const { pathname } = request.nextUrl;

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const cspHeader = buildCspHeader(nonce);

  // 1. If user is authenticated and tries to access auth pages, redirect to dashboard
  if (token && AUTH_ROUTES.some((route) => pathname.startsWith(route))) {
    return applySecurityHeaders(
      NextResponse.redirect(new URL("/dashboard", request.url)),
      cspHeader,
    );
  }

  // 2. If user is NOT authenticated and tries to access protected pages, redirect to login
  if (!token && PROTECTED_ROUTES.some((route) => pathname.startsWith(route))) {
    return applySecurityHeaders(
      NextResponse.redirect(new URL("/auth/login", request.url)),
      cspHeader,
    );
  }

  const requestHeaders = new Headers(request.headers ?? undefined);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  return applySecurityHeaders(
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    }),
    cspHeader,
  );
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
    "/dashboard/:path*",
    "/post-job/:path*",
    "/messages/:path*",
    "/profile/:path*",
    "/auth/:path*",
  ],
};
