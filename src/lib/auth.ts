import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

/**
 * Stateless JWT session auth (httpOnly cookie). Roles: ADMIN > ANALYST > VIEWER.
 */

const COOKIE_NAME = "tm_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not configured");
  return new TextEncoder().encode(s);
}

export interface SessionUser {
  id: string;
  email: string;
  role: "ADMIN" | "ANALYST" | "VIEWER";
  name?: string | null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(user: SessionUser): Promise<void> {
  const token = await new SignJWT({
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(secret());

  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SEC,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  cookies().delete(COOKIE_NAME);
}

export async function getSession(): Promise<SessionUser | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      id: String(payload.sub),
      email: String(payload.email),
      role: payload.role as SessionUser["role"],
      name: (payload.name as string) ?? null,
    };
  } catch {
    return null;
  }
}

const ROLE_RANK = { VIEWER: 0, ANALYST: 1, ADMIN: 2 } as const;

export async function requireRole(min: SessionUser["role"]): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new AuthError(401, "Authentication required");
  if (ROLE_RANK[session.role] < ROLE_RANK[min]) {
    throw new AuthError(403, "Insufficient permissions");
  }
  return session;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
