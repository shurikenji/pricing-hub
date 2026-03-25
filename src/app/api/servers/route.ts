import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isAdminRequest } from "@/lib/admin-auth";
import { redactServerSecrets } from "@/lib/secure-config";
import { appendAuditLog } from "@/lib/server-db";
import { getServerCapability, validateServerConfigCapabilities } from "@/lib/server-capabilities";
import { addServer, getAllServers, getServer, getServers, removeServer, updateServer } from "@/lib/servers";
import type { ServerConfig } from "@/lib/types";

function sanitizePublicServer(server: ServerConfig) {
  const capability = getServerCapability(server);
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    supportsGroupChain: server.supportsGroupChain,
    groupSelectionMode: capability.groupSelectionMode,
    groupMatchMode: capability.groupMatchMode,
    ratioConfigEnabled: server.ratioConfigEnabled,
    notes: server.notes,
  };
}

function getActor(request: Request) {
  return request.headers.get("x-forwarded-for") || "admin-session";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const adminMode = searchParams.get("admin") === "1";
  const serverId = searchParams.get("id");

  if (adminMode) {
    if (!isAdminRequest(request)) {
      return apiError("UNAUTHORIZED", "Unauthorized", 401);
    }
    if (serverId) {
      const server = getServer(serverId);
      return server
        ? NextResponse.json(server)
        : apiError("SERVER_NOT_FOUND", "Server not found", 404);
    }
    return NextResponse.json(getAllServers());
  }

  return NextResponse.json(getServers().map(sanitizePublicServer));
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json()) as ServerConfig;
  if (!body.id || !body.name || !body.baseUrl || !body.type) {
    return apiError("SERVER_FIELDS_REQUIRED", "Missing required fields", 400);
  }

  const validationErrors = validateServerConfigCapabilities(body);
  if (validationErrors.length > 0) {
    return apiError("INVALID_SERVER_CAPABILITY", "Server capability configuration is invalid.", 400, validationErrors);
  }

  addServer(body);
  appendAuditLog({
    action: "server.created",
    targetType: "server",
    targetId: body.id,
    detail: JSON.stringify({
      actor: getActor(request),
      server: redactServerSecrets({
        id: body.id,
        name: body.name,
        type: body.type,
        baseUrl: body.baseUrl,
        authUserValue: body.authUserValue,
        authToken: body.authToken,
        authCookie: body.authCookie,
      }),
    }),
  });
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json()) as Partial<ServerConfig> & { id?: string };
  if (!body.id) {
    return apiError("SERVER_ID_REQUIRED", "Missing server id", 400);
  }

  const before = getServer(body.id);
  const validationErrors = before ? validateServerConfigCapabilities({ ...before, ...body }) : [];
  if (validationErrors.length > 0) {
    return apiError("INVALID_SERVER_CAPABILITY", "Server capability configuration is invalid.", 400, validationErrors);
  }
  const ok = updateServer(body.id, body);
  if (!ok) {
    return apiError("SERVER_NOT_FOUND", "Server not found", 404);
  }

  appendAuditLog({
    action: "server.updated",
    targetType: "server",
    targetId: body.id,
    detail: JSON.stringify({
      actor: getActor(request),
      before: redactServerSecrets(before),
      changedFields: Object.keys(body).filter((key) => key !== "id"),
    }),
  });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return apiError("SERVER_ID_REQUIRED", "Missing id", 400);
  }

  const before = getServer(id);
  const ok = removeServer(id);
  if (!ok) {
    return apiError("SERVER_NOT_FOUND", "Server not found", 404);
  }

  appendAuditLog({
    action: "server.deleted",
    targetType: "server",
    targetId: id,
    detail: JSON.stringify({
      actor: getActor(request),
      before: redactServerSecrets(before),
    }),
  });
  return NextResponse.json({ success: true });
}
