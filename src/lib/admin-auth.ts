import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

const COOKIE_NAME = "pricing_hub_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function getAdminSecret() {
  return process.env.ADMIN_SECRET || "";
}

function signSession(expiresAt: number) {
  return createHmac("sha256", getAdminSecret()).update(String(expiresAt)).digest("hex");
}

export function createAdminSessionValue() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  return `${expiresAt}.${signSession(expiresAt)}`;
}

export function verifyAdminSession(value?: string | null) {
  if (!value || !getAdminSecret()) {
    return false;
  }

  const [expiresRaw, signature] = value.split(".");
  const expiresAt = Number(expiresRaw);
  if (!expiresAt || !signature || expiresAt < Date.now()) {
    return false;
  }

  const expected = Buffer.from(signSession(expiresAt), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

export function isAdminRequest(request: Request) {
  const headerSecret = request.headers.get("x-admin-secret");
  if (headerSecret && headerSecret === getAdminSecret()) {
    return true;
  }

  const cookieHeader = request.headers.get("cookie") || "";
  const cookieValue = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  return verifyAdminSession(cookieValue);
}

export function applyAdminSession(response: NextResponse) {
  response.cookies.set({
    name: COOKIE_NAME,
    value: createAdminSessionValue(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearAdminSession(response: NextResponse) {
  response.cookies.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function validateAdminSecret(secret: string) {
  return Boolean(secret) && secret === getAdminSecret();
}
