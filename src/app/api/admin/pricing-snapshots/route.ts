import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isAdminRequest } from "@/lib/admin-auth";
import { getAdapter } from "@/lib/adapters";
import {
  appendAuditLog,
  comparePricingSnapshots,
  getLatestPricingSnapshot,
  getPricingSnapshotRecord,
  insertPricingSnapshot,
  listPricingSnapshotRecords,
  listPricingSnapshots,
} from "@/lib/server-db";
import { getAllServers, getServer, updateServer } from "@/lib/servers";
import type { PricingSyncRunItem, PricingSyncRunResponse, ServerConfig } from "@/lib/types";

function parseSnapshotId(value: string | null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getSyncIntervalMinutes(config: ServerConfig) {
  return Math.max(5, config.autoSyncIntervalMinutes || 180);
}

function buildNextPricingSyncAt(config: ServerConfig, fromTimestamp: number) {
  if (!config.autoSyncEnabled) {
    return undefined;
  }
  return fromTimestamp + getSyncIntervalMinutes(config) * 60_000;
}

async function syncServerPricing(config: ServerConfig, trigger: "manual" | "auto"): Promise<PricingSyncRunItem> {
  try {
    const adapter = getAdapter(config);
    const pricing = await adapter.fetchPricing(config);
    const snapshotId = insertPricingSnapshot(config.id, pricing);
    updateServer(config.id, {
      lastPricingSyncAt: pricing.fetchedAt,
      lastPricingSyncStatus: "success",
      lastPricingSyncError: "",
      lastNormalizeError: "",
      lastSyncErrorCode: "",
      lastSyncModelCount: pricing.models.length,
      lastSyncGroupCount: pricing.groups.length,
      nextPricingSyncAt: buildNextPricingSyncAt(config, pricing.fetchedAt),
    });

    appendAuditLog({
      action: trigger === "auto" ? "pricing.auto_sync_succeeded" : "pricing.snapshot_synced",
      targetType: "server",
      targetId: config.id,
      detail: JSON.stringify({
        snapshotId,
        serverName: config.name,
        modelCount: pricing.models.length,
        groupCount: pricing.groups.length,
        trigger,
      }),
    });

    return {
      serverId: config.id,
      serverName: config.name,
      success: true,
      snapshotId,
      modelCount: pricing.models.length,
      groupCount: pricing.groups.length,
      fetchedAt: pricing.fetchedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to sync pricing snapshot";
    updateServer(config.id, {
      lastPricingSyncStatus: "error",
      lastPricingSyncError: message,
      lastNormalizeError: message,
      lastSyncErrorCode: "UPSTREAM_SYNC_FAILED",
      nextPricingSyncAt: buildNextPricingSyncAt(config, Date.now()),
    });

    appendAuditLog({
      action: trigger === "auto" ? "pricing.auto_sync_failed" : "pricing.snapshot_failed",
      targetType: "server",
      targetId: config.id,
      detail: JSON.stringify({
        serverName: config.name,
        error: message,
        trigger,
      }),
    });

    return {
      serverId: config.id,
      serverName: config.name,
      success: false,
      error: message,
    };
  }
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") || "20");
  const serverId = searchParams.get("server") || undefined;
  const shouldCompare = searchParams.get("diff") === "1";
  const snapshotId = parseSnapshotId(searchParams.get("snapshotId"));
  const includeRecords = searchParams.get("records") === "1";

  if (snapshotId) {
    const snapshot = getPricingSnapshotRecord(snapshotId);
    if (!snapshot) {
      return apiError("SNAPSHOT_NOT_FOUND", "Snapshot not found", 404);
    }
    return NextResponse.json(snapshot);
  }

  if (shouldCompare) {
    if (!serverId) {
      return apiError("SERVER_REQUIRED", "Missing server id for diff mode", 400);
    }

    const baseSnapshotId = parseSnapshotId(searchParams.get("baseSnapshotId"));
    const compareSnapshotId = parseSnapshotId(searchParams.get("compareSnapshotId"));
    const diff = comparePricingSnapshots(
      serverId,
      baseSnapshotId,
      compareSnapshotId,
    );

    if (!diff) {
      return apiError("SNAPSHOT_DIFF_UNAVAILABLE", "Not enough snapshot history to compare", 404);
    }

    return NextResponse.json(diff);
  }

  if (includeRecords) {
    if (!serverId) {
      return apiError("SERVER_REQUIRED", "Missing server id for record listing", 400);
    }
    return NextResponse.json(listPricingSnapshotRecords(serverId, Number.isFinite(limit) ? limit : 12));
  }

  return NextResponse.json(listPricingSnapshots(Number.isFinite(limit) ? limit : 20, serverId));
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json().catch(() => ({}))) as { serverId?: string; runDue?: boolean; dryRun?: boolean };

  if (body.runDue) {
    const now = Date.now();
    const dueServers = getAllServers().filter(
      (server) => server.enabled && server.autoSyncEnabled && (!server.nextPricingSyncAt || server.nextPricingSyncAt <= now),
    );

    const items: PricingSyncRunItem[] = [];
    for (const server of dueServers) {
      items.push(await syncServerPricing(server, "auto"));
    }

    const response: PricingSyncRunResponse = {
      ranAt: now,
      triggeredCount: items.length,
      successCount: items.filter((item) => item.success).length,
      failureCount: items.filter((item) => !item.success).length,
      items,
    };

    return NextResponse.json(response);
  }

  if (!body.serverId) {
    return apiError("SERVER_REQUIRED", "Missing serverId", 400);
  }

  const config = getServer(body.serverId);
  if (!config) {
    return apiError("SERVER_NOT_FOUND", "Server not found", 404);
  }

  if (body.dryRun) {
    try {
      const adapter = getAdapter(config);
      const pricing = await adapter.fetchPricing(config);
      const latestSnapshot = getLatestPricingSnapshot(config.id);
      const diff = latestSnapshot ? comparePricingSnapshots(config.id, latestSnapshot.id, latestSnapshot.id) : null;
      const responseDiff = latestSnapshot
        ? (() => {
            const previous = getPricingSnapshotRecord(latestSnapshot.id);
            if (!previous) {
              return null;
            }

            const previousNames = new Set(previous.pricing.models.map((model) => model.modelName));
            const currentNames = new Set(pricing.models.map((model) => model.modelName));
            const changed = pricing.models
              .filter((model) => {
                const previousModel = previous.pricing.models.find((item) => item.modelName === model.modelName);
                if (!previousModel) {
                  return true;
                }
                return (
                  previousModel.pricingMode !== model.pricingMode ||
                  previousModel.inputPricePer1M !== model.inputPricePer1M ||
                  previousModel.outputPricePer1M !== model.outputPricePer1M ||
                  previousModel.requestPrice !== model.requestPrice ||
                  previousModel.enableGroups.join("|") !== model.enableGroups.join("|")
                );
              })
              .length;

            return {
              previousSnapshotId: previous.id,
              previousFetchedAt: previous.fetchedAt,
              addedCount: pricing.models.filter((model) => !previousNames.has(model.modelName)).length,
              removedCount: previous.pricing.models.filter((model) => !currentNames.has(model.modelName)).length,
              changedCount: changed,
            };
          })()
        : null;

      appendAuditLog({
        action: "pricing.dry_run",
        targetType: "server",
        targetId: config.id,
        detail: JSON.stringify({
          serverName: config.name,
          modelCount: pricing.models.length,
          groupCount: pricing.groups.length,
        }),
      });

      return NextResponse.json({
        success: true,
        mode: "dry_run",
        modelCount: pricing.models.length,
        groupCount: pricing.groups.length,
        fetchedAt: pricing.fetchedAt,
        latestSnapshotId: latestSnapshot?.id,
        latestSnapshotAgeMs: latestSnapshot ? Date.now() - latestSnapshot.fetchedAt : undefined,
        diff: responseDiff,
        pricing: {
          serverName: pricing.serverName,
          models: pricing.models.slice(0, 20),
          groups: pricing.groups.slice(0, 20),
        },
        compare: diff,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to dry-run pricing sync";
      updateServer(config.id, {
        lastNormalizeError: message,
        lastSyncErrorCode: "DRY_RUN_FAILED",
      });
      return apiError("DRY_RUN_FAILED", message, 502);
    }
  }

  const result = await syncServerPricing(config, "manual");
  if (!result.success) {
    console.error("Pricing snapshot sync error:", result.error);
    return apiError(result.errorCode || "PRICING_SYNC_FAILED", result.error || "Failed to sync pricing snapshot", 502);
  }

  return NextResponse.json({
    success: true,
    snapshotId: result.snapshotId,
    modelCount: result.modelCount,
    groupCount: result.groupCount,
    fetchedAt: result.fetchedAt,
  });
}
