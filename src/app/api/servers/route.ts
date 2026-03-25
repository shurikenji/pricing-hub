import { NextResponse } from "next/server";

import { isAdminRequest } from "@/lib/admin-auth";
import { appendAuditLog } from "@/lib/server-db";
import { addServer, getAllServers, getServer, getServers, removeServer, updateServer } from "@/lib/servers";
import type { ServerConfig } from "@/lib/types";

function sanitizePublicServer(server: ServerConfig) {
  return {
    id: server.id,
    name: server.name,
    type: server.type,
    supportsGroupChain: server.supportsGroupChain,
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
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (serverId) {
      const server = getServer(serverId);
      return server
        ? NextResponse.json(server)
        : NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    return NextResponse.json(getAllServers());
  }

  return NextResponse.json(getServers().map(sanitizePublicServer));
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as ServerConfig;
  if (!body.id || !body.name || !body.baseUrl || !body.type) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  addServer(body);
  appendAuditLog({
    action: "server.created",
    targetType: "server",
    targetId: body.id,
    detail: JSON.stringify({
      actor: getActor(request),
      name: body.name,
      type: body.type,
      baseUrl: body.baseUrl,
    }),
  });
  return NextResponse.json({ success: true });
}

export async function PUT(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as Partial<ServerConfig> & { id?: string };
  if (!body.id) {
    return NextResponse.json({ error: "Missing server id" }, { status: 400 });
  }

  const before = getServer(body.id);
  const ok = updateServer(body.id, body);
  if (!ok) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  appendAuditLog({
    action: "server.updated",
    targetType: "server",
    targetId: body.id,
    detail: JSON.stringify({
      actor: getActor(request),
      before,
      changedFields: Object.keys(body).filter((key) => key !== "id"),
    }),
  });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const before = getServer(id);
  const ok = removeServer(id);
  if (!ok) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  appendAuditLog({
    action: "server.deleted",
    targetType: "server",
    targetId: id,
    detail: JSON.stringify({
      actor: getActor(request),
      before,
    }),
  });
  return NextResponse.json({ success: true });
}
