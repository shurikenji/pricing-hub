import { NextResponse } from "next/server";

import {
  applyAdminSession,
  clearAdminSession,
  isAdminRequest,
  validateAdminSecret,
} from "@/lib/admin-auth";

export async function GET(request: Request) {
  return NextResponse.json({ authenticated: isAdminRequest(request) });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { secret?: string };
  if (!validateAdminSecret(body.secret || "")) {
    return NextResponse.json({ error: "Invalid admin secret" }, { status: 401 });
  }

  const response = NextResponse.json({ authenticated: true });
  applyAdminSession(response);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  clearAdminSession(response);
  return response;
}
