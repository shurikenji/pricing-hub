import { NextResponse } from "next/server";

import {
  applyAdminSession,
  clearAdminSession,
  isAdminRequest,
  validateAdminSecret,
} from "@/lib/admin-auth";

const MAX_FAILED_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const attemptStore = new Map<string, { count: number; firstAttemptAt: number; blockedUntil?: number }>();

function getClientKey(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function getRateLimitState(clientKey: string) {
  const current = attemptStore.get(clientKey);
  if (!current) {
    return { count: 0, firstAttemptAt: Date.now() };
  }

  if (current.blockedUntil && current.blockedUntil > Date.now()) {
    return current;
  }

  if (Date.now() - current.firstAttemptAt > WINDOW_MS) {
    const reset = { count: 0, firstAttemptAt: Date.now() };
    attemptStore.set(clientKey, reset);
    return reset;
  }

  return current;
}

function registerFailedAttempt(clientKey: string) {
  const current = getRateLimitState(clientKey);
  const nextCount = current.count + 1;
  const next = {
    count: nextCount,
    firstAttemptAt: current.count === 0 ? Date.now() : current.firstAttemptAt,
    blockedUntil: nextCount >= MAX_FAILED_ATTEMPTS ? Date.now() + BLOCK_MS : undefined,
  };
  attemptStore.set(clientKey, next);
  return next;
}

function clearFailedAttempts(clientKey: string) {
  attemptStore.delete(clientKey);
}

export async function GET(request: Request) {
  return NextResponse.json({ authenticated: isAdminRequest(request) });
}

export async function POST(request: Request) {
  const clientKey = getClientKey(request);
  const state = getRateLimitState(clientKey);
  if (state.blockedUntil && state.blockedUntil > Date.now()) {
    return NextResponse.json(
      {
        error: "Too many failed login attempts. Try again later.",
        retryAfterSeconds: Math.ceil((state.blockedUntil - Date.now()) / 1000),
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((state.blockedUntil - Date.now()) / 1000)),
        },
      },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { secret?: string };
  if (!validateAdminSecret(body.secret || "")) {
    const nextState = registerFailedAttempt(clientKey);
    return NextResponse.json(
      {
        error: "Invalid admin secret",
        remainingAttempts: Math.max(MAX_FAILED_ATTEMPTS - nextState.count, 0),
      },
      { status: 401 },
    );
  }

  clearFailedAttempts(clientKey);
  const response = NextResponse.json({ authenticated: true });
  applyAdminSession(response);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  clearAdminSession(response);
  return response;
}
