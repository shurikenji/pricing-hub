import { NextResponse } from "next/server";

import { buildHeaders, joinUrl } from "@/lib/adapters/helpers";
import { getAdapter } from "@/lib/adapters";
import { getServer } from "@/lib/servers";

function normalizeGroups(raw: Record<string, unknown>): string[] {
  const direct = raw.TokenGroup ?? raw.group ?? raw.selected_groups;
  if (Array.isArray(direct)) {
    return direct.filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  if (typeof direct === "string") {
    return direct
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function buildUpdatePayload(type: string, raw: Record<string, unknown>, groups: string[]) {
  const joined = groups.join(",");
  const remainQuota =
    typeof raw.remain_quota === "number"
      ? raw.remain_quota
      : typeof raw.remainQuota === "number"
        ? raw.remainQuota
        : 0;

  if (type === "rixapi") {
    return {
      id: raw.id,
      remain_quota: remainQuota,
      name: raw.name,
      group: joined,
      TokenGroup: joined,
      expired_time: raw.expired_time ?? -1,
      key: raw.key,
      user_id: raw.user_id,
      created_time: raw.created_time,
      updated_time: raw.updated_time,
      status: raw.status,
      is_active: raw.is_active,
      mj_mode: raw.mj_mode ?? "默认",
      mj_cdn: raw.mj_cdn ?? "默认",
      mj_cdn_addr: raw.mj_cdn_addr ?? "",
      remain_count: raw.remain_count ?? 0,
      unlimited_count: raw.unlimited_count ?? true,
      model_limits_enabled: raw.model_limits_enabled ?? false,
      model_limits: raw.model_limits ?? "",
      allow_ips: raw.allow_ips ?? "",
      exclude_ips: raw.exclude_ips ?? "",
      rate_limits_enabled: raw.rate_limits_enabled ?? false,
      rate_limits_time: raw.rate_limits_time ?? 10,
      rate_limits_count: raw.rate_limits_count ?? 900,
      rate_limits_content: raw.rate_limits_content ?? "",
    };
  }

  return {
    id: raw.id,
    remain_quota: remainQuota,
    name: raw.name,
    group: joined,
    selected_groups: groups.length > 1 ? groups : undefined,
    expired_time: raw.expired_time ?? -1,
    unlimited_quota: raw.unlimited_quota ?? false,
    model_limits_enabled: raw.model_limits_enabled ?? false,
    model_limits: raw.model_limits ?? "",
    allow_ips: raw.allow_ips ?? "",
    key: raw.key,
    user_id: raw.user_id,
    created_time: raw.created_time,
    updated_time: raw.updated_time,
    status: raw.status,
    is_active: raw.is_active,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { serverId?: string; apiKey?: string };
    if (!body.serverId || !body.apiKey) {
      return NextResponse.json({ error: "Missing serverId or apiKey" }, { status: 400 });
    }

    const config = getServer(body.serverId);
    if (!config) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    if (!config.authToken || !config.authUserValue) {
      return NextResponse.json({ error: "Server admin credentials are not configured." }, { status: 400 });
    }

    const adapter = getAdapter(config);
    const token = await adapter.searchToken(config, body.apiKey);
    if (!token) {
      return NextResponse.json({ error: "API key not found on this server." }, { status: 404 });
    }

    const pricing = await adapter.fetchPricing(config);
    return NextResponse.json({
      token: {
        id: token.id,
        name: token.name,
        key: token.key,
        remainQuota: token.remainQuota,
        usedQuota: token.usedQuota,
        currentGroups: normalizeGroups(token.raw),
      },
      availableGroups: pricing.groups,
      supportsGroupChain: config.supportsGroupChain,
    });
  } catch (error) {
    console.error("Key resolve error:", error);
    return NextResponse.json({ error: "Failed to resolve API key" }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { serverId?: string; apiKey?: string; groups?: string[] };
    if (!body.serverId || !body.apiKey || !Array.isArray(body.groups) || body.groups.length === 0) {
      return NextResponse.json({ error: "Missing serverId, apiKey, or groups" }, { status: 400 });
    }

    const config = getServer(body.serverId);
    if (!config) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    if (!config.authToken || !config.authUserValue) {
      return NextResponse.json({ error: "Server admin credentials are not configured." }, { status: 400 });
    }
    if (!config.supportsGroupChain && body.groups.length > 1) {
      return NextResponse.json({ error: "This server allows only one group." }, { status: 400 });
    }

    const adapter = getAdapter(config);
    const token = await adapter.searchToken(config, body.apiKey);
    if (!token?.raw) {
      return NextResponse.json({ error: "API key not found on this server." }, { status: 404 });
    }

    const payload = buildUpdatePayload(config.type, token.raw, body.groups);
    const updateRes = await fetch(joinUrl(config.baseUrl, "/api/token/"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...buildHeaders(config),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const updatePayload = await updateRes.json().catch(() => null);
    if (!updateRes.ok || !updatePayload?.success) {
      return NextResponse.json(
        { error: updatePayload?.message || `Update failed with status ${updateRes.status}` },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      currentGroups: body.groups,
      tokenName: token.name,
    });
  } catch (error) {
    console.error("Key update error:", error);
    return NextResponse.json({ error: "Failed to update API key groups" }, { status: 502 });
  }
}
