import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isAdminRequest } from "@/lib/admin-auth";
import { runServerHealthCheck } from "@/lib/server-health";
import { appendAuditLog, appendHealthHistory, listHealthHistory } from "@/lib/server-db";
import { getAllServers, getServer, updateServer } from "@/lib/servers";
import type { ServerHealthResult, ServerHealthRunResponse } from "@/lib/types";

function getActor(request: Request) {
  return request.headers.get("x-forwarded-for") || "admin-session";
}

function persistHealthResult(result: ServerHealthResult) {
  updateServer(result.serverId, {
    lastHealthCheckAt: result.checkedAt,
    lastHealthStatus: result.status,
    lastHealthLatencyMs: result.latencyMs,
    lastHealthHttpStatus: result.httpStatus,
    lastHealthMessage: result.message,
  });
  appendHealthHistory(result);
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId") || undefined;
  const withHistory = searchParams.get("history") === "1";

  if (withHistory) {
    return NextResponse.json(listHealthHistory(serverId, 20));
  }

  return NextResponse.json(
    getAllServers().map((server) => ({
      serverId: server.id,
      serverName: server.name,
      status: server.lastHealthStatus || "unknown",
      checkedAt: server.lastHealthCheckAt || 0,
      latencyMs: server.lastHealthLatencyMs || 0,
      httpStatus: server.lastHealthHttpStatus,
      message: server.lastHealthMessage || "Health check has not been run yet.",
    })),
  );
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json().catch(() => ({}))) as { serverId?: string };
  const targets = body.serverId ? [getServer(body.serverId)].filter(Boolean) : getAllServers().filter((server) => server.enabled);
  if (targets.length === 0) {
    return apiError("SERVER_NOT_FOUND", "No server found for health check", 404);
  }

  const items: ServerHealthResult[] = [];
  for (const server of targets) {
    const result = await runServerHealthCheck(server!);
    persistHealthResult(result);
    items.push(result);
  }

  appendAuditLog({
    action: "health.checked",
    targetType: "server",
    targetId: body.serverId || "all",
    detail: JSON.stringify({
      actor: getActor(request),
      checkedCount: items.length,
      downCount: items.filter((item) => item.status === "down").length,
      degradedCount: items.filter((item) => item.status === "degraded").length,
    }),
  });

  const response: ServerHealthRunResponse = {
    checkedAt: Date.now(),
    checkedCount: items.length,
    healthyCount: items.filter((item) => item.status === "healthy").length,
    degradedCount: items.filter((item) => item.status === "degraded").length,
    downCount: items.filter((item) => item.status === "down").length,
    items,
  };

  return NextResponse.json(response);
}
