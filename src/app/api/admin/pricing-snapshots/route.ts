import { NextResponse } from "next/server";

import { isAdminRequest } from "@/lib/admin-auth";
import { getAdapter } from "@/lib/adapters";
import { appendAuditLog, insertPricingSnapshot, listPricingSnapshots } from "@/lib/server-db";
import { getServer } from "@/lib/servers";

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") || "20");
  const serverId = searchParams.get("server") || undefined;
  return NextResponse.json(listPricingSnapshots(Number.isFinite(limit) ? limit : 20, serverId));
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { serverId?: string };
  if (!body.serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const config = getServer(body.serverId);
  if (!config) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  try {
    const adapter = getAdapter(config);
    const pricing = await adapter.fetchPricing(config);
    const snapshotId = insertPricingSnapshot(body.serverId, pricing);

    appendAuditLog({
      action: "pricing.snapshot_synced",
      targetType: "server",
      targetId: body.serverId,
      detail: JSON.stringify({
        snapshotId,
        serverName: config.name,
        modelCount: pricing.models.length,
        groupCount: pricing.groups.length,
      }),
    });

    return NextResponse.json({
      success: true,
      snapshotId,
      modelCount: pricing.models.length,
      groupCount: pricing.groups.length,
      fetchedAt: pricing.fetchedAt,
    });
  } catch (error) {
    console.error("Pricing snapshot sync error:", error);
    return NextResponse.json({ error: "Failed to sync pricing snapshot" }, { status: 502 });
  }
}
