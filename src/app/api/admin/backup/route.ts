import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isAdminRequest } from "@/lib/admin-auth";
import { appendAuditLog, listPricingSnapshots, listServerSamples, upsertServerSample } from "@/lib/server-db";
import { addServer, getAllServers, removeServer, updateServer } from "@/lib/servers";
import type { AdminBackupBundle, BackupImportResponse, ServerConfig } from "@/lib/types";

function getActor(request: Request) {
  return request.headers.get("x-forwarded-for") || "admin-session";
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const bundle: AdminBackupBundle = {
    version: 1,
    exportedAt: Date.now(),
    servers: getAllServers(),
    pricingSnapshots: listPricingSnapshots(200),
    samples: listServerSamples(),
  };

  appendAuditLog({
    action: "backup.exported",
    targetType: "backup",
    detail: JSON.stringify({
      actor: getActor(request),
      serverCount: bundle.servers.length,
      snapshotSummaryCount: bundle.pricingSnapshots.length,
      sampleCount: bundle.samples?.length || 0,
    }),
  });

  return NextResponse.json(bundle, {
    headers: {
      "Content-Disposition": `attachment; filename="pricing-hub-backup-${bundle.exportedAt}.json"`,
    },
  });
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json().catch(() => null)) as
    | {
        mode?: "merge" | "replace";
        bundle?: AdminBackupBundle;
      }
    | null;

  const mode = body?.mode === "merge" ? "merge" : "replace";
  const bundle = body?.bundle;
  if (!bundle || !Array.isArray(bundle.servers)) {
    return apiError("INVALID_BACKUP", "Invalid backup payload", 400);
  }

  const currentServers = getAllServers();
  const currentIds = new Set(currentServers.map((server) => server.id));
  const incomingIds = new Set(bundle.servers.map((server) => server.id));
  let importedServers = 0;
  let removedServers = 0;

  if (mode === "replace") {
    for (const server of currentServers) {
      if (!incomingIds.has(server.id)) {
        removeServer(server.id);
        removedServers += 1;
      }
    }
  }

  for (const server of bundle.servers as ServerConfig[]) {
    if (currentIds.has(server.id)) {
      updateServer(server.id, server);
    } else {
      addServer(server);
    }
    importedServers += 1;
  }

  for (const sample of bundle.samples || []) {
    upsertServerSample(sample);
  }

  appendAuditLog({
    action: "backup.imported",
    targetType: "backup",
    detail: JSON.stringify({
      actor: getActor(request),
      mode,
      importedServers,
      removedServers,
      skippedSnapshotSummaries: bundle.pricingSnapshots?.length || 0,
      importedSamples: bundle.samples?.length || 0,
    }),
  });

  const response: BackupImportResponse = {
    importedServers,
    removedServers,
    skippedSnapshotSummaries: bundle.pricingSnapshots?.length || 0,
    importedSamples: bundle.samples?.length || 0,
  };

  return NextResponse.json(response);
}
