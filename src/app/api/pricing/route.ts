import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { getAdapter } from "@/lib/adapters";
import { getLatestPricingSnapshot, insertPricingSnapshot } from "@/lib/server-db";
import { consumeRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { getServer, updateServer } from "@/lib/servers";

export const revalidate = 300;

function getSnapshotTtlMs(intervalMinutes?: number) {
  const minutes = Math.max(5, intervalMinutes || 15);
  return minutes * 60_000;
}

export async function GET(request: Request) {
  const ip = getClientIdentifier(request);
  const bucket = consumeRateLimit(`pricing:${ip}`, 60, 60_000);
  if (!bucket.allowed) {
    return apiError("RATE_LIMITED", "Too many pricing lookups. Please retry shortly.", 429);
  }

  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("server");

  if (!serverId) {
    return apiError("SERVER_REQUIRED", "Missing server parameter", 400);
  }

  const config = getServer(serverId);
  if (!config) {
    return apiError("SERVER_NOT_FOUND", "Server not found", 404);
  }

  const latestSnapshot = getLatestPricingSnapshot(serverId);
  const snapshotTtlMs = getSnapshotTtlMs(config.autoSyncEnabled ? config.autoSyncIntervalMinutes : 15);
  const snapshotAgeMs = latestSnapshot ? Date.now() - latestSnapshot.fetchedAt : undefined;

  if (latestSnapshot && typeof snapshotAgeMs === "number" && snapshotAgeMs <= snapshotTtlMs) {
    return NextResponse.json(latestSnapshot.pricing, {
      headers: {
        "x-pricing-source": "snapshot",
        "x-pricing-snapshot-id": String(latestSnapshot.id),
        "x-pricing-age-ms": String(snapshotAgeMs),
      },
    });
  }

  try {
    const adapter = getAdapter(config);
    const pricing = await adapter.fetchPricing(config);
    let snapshotId: number | undefined;

    try {
      snapshotId = insertPricingSnapshot(serverId, pricing);
      updateServer(serverId, {
        lastPricingSyncAt: pricing.fetchedAt,
        lastPricingSyncStatus: "success",
        lastPricingSyncError: "",
        lastNormalizeError: "",
        lastSyncErrorCode: "",
        lastSyncModelCount: pricing.models.length,
        lastSyncGroupCount: pricing.groups.length,
        nextPricingSyncAt: config.autoSyncEnabled
          ? pricing.fetchedAt + Math.max(5, config.autoSyncIntervalMinutes || 180) * 60_000
          : undefined,
      });
    } catch (snapshotError) {
      console.error(`Snapshot save error for ${serverId}:`, snapshotError);
    }

    return NextResponse.json(pricing, {
      headers: {
        "x-pricing-source": "upstream",
        ...(snapshotId ? { "x-pricing-snapshot-id": String(snapshotId) } : {}),
      },
    });
  } catch (err) {
    console.error(`Pricing fetch error for ${serverId}:`, err);
    updateServer(serverId, {
      lastPricingSyncStatus: "error",
      lastPricingSyncError: err instanceof Error ? err.message : "Failed to fetch pricing data",
      lastNormalizeError: err instanceof Error ? err.message : "Failed to fetch pricing data",
      lastSyncErrorCode: "PRICING_FETCH_FAILED",
    });

    if (latestSnapshot) {
      return NextResponse.json(latestSnapshot.pricing, {
        headers: {
          "x-pricing-source": "stale-snapshot",
          "x-pricing-snapshot-id": String(latestSnapshot.id),
          "x-pricing-age-ms": String(Date.now() - latestSnapshot.fetchedAt),
        },
      });
    }

    return apiError("PRICING_FETCH_FAILED", "Failed to fetch pricing data", 502);
  }
}
