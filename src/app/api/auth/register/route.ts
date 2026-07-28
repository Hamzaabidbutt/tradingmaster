import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession, hashPassword } from "@/lib/auth";
import { rateLimit } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(190),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80).optional(),
});

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "local";
  const rl = rateLimit(`register:${ip}`, 10, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Email already registered" }, { status: 409 });
  }

  // First registered user becomes ADMIN; everyone after is a VIEWER.
  const userCount = await prisma.user.count();
  const user = await prisma.user.create({
    data: {
      email,
      name,
      password: await hashPassword(password),
      role: userCount === 0 ? "ADMIN" : "VIEWER",
    },
  });

  await prisma.auditLog.create({
    data: { userId: user.id, action: "user.register", meta: { email } },
  });

  await createSession({ id: user.id, email: user.email, role: user.role, name: user.name });
  logger.info("auth.registered", { userId: user.id });
  return NextResponse.json({ id: user.id, email: user.email, role: user.role });
}
