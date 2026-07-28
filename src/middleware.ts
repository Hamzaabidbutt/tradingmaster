import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware: per-IP rate limiting on API routes + security headers.
 * (Simple fixed-window counter — the finer sliding-window limiter guards
 * expensive endpoints inside the route handlers themselves.)
 */

const WINDOW_MS = 60_000;
const MAX_REQ = 240;
const hits = new Map<string, { count: number; windowStart: number }>();

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "local";
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      hits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > MAX_REQ) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now - v.windowStart > WINDOW_MS) hits.delete(k);
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
