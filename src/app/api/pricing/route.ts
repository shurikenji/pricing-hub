import { NextResponse } from "next/server";

import { getAdapter } from "@/lib/adapters";
import { insertPricingSnapshot } from "@/lib/server-db";
import { getServer } from "@/lib/servers";

export const revalidate = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("server");

  if (!serverId) {
    return NextResponse.json({ error: "Missing server parameter" }, { status: 400 });
  }

  const config = getServer(serverId);
  if (!config) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  try {
    const adapter = getAdapter(config);
    const pricing = await adapter.fetchPricing(config);

    try {
      insertPricingSnapshot(serverId, pricing);
    } catch (snapshotError) {
      console.error(`Snapshot save error for ${serverId}:`, snapshotError);
    }

    return NextResponse.json(pricing);
  } catch (err) {
    console.error(`Pricing fetch error for ${serverId}:`, err);
    return NextResponse.json({ error: "Failed to fetch pricing data" }, { status: 502 });
  }
}
