import { NextResponse } from "next/server";

import { isAdminRequest } from "@/lib/admin-auth";
import { listAuditLogs } from "@/lib/server-db";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") || "20");
  return NextResponse.json(listAuditLogs(Number.isFinite(limit) ? limit : 20));
}
