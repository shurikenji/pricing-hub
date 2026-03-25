import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { getAdapter } from "@/lib/adapters";
import { buildHeaders, joinUrl } from "@/lib/adapters/helpers";
import { consumeRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { getServerCapability, matchModelsByGroups, normalizeSelectedGroups } from "@/lib/server-capabilities";
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

function buildUpdatePayload(updateMode: "newapi_put" | "rixapi_put" | "custom", raw: Record<string, unknown>, groups: string[]) {
  const joined = groups.join(",");
  const remainQuota =
    typeof raw.remain_quota === "number"
      ? raw.remain_quota
      : typeof raw.remainQuota === "number"
        ? raw.remainQuota
        : 0;

  if (updateMode === "rixapi_put") {
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

  if (updateMode === "newapi_put") {
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

  return null;
}

function enforceKeyRateLimit(request: Request, action: "resolve" | "update") {
  const ip = getClientIdentifier(request);
  const bucket = consumeRateLimit(`keys:${action}:${ip}`, action === "resolve" ? 30 : 20, 60_000);
  return bucket.allowed ? null : apiError("RATE_LIMITED", "Too many key operations. Please retry shortly.", 429);
}

export async function POST(request: Request) {
  const rateLimited = enforceKeyRateLimit(request, "resolve");
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = (await request.json()) as { serverId?: string; apiKey?: string };
    if (!body.serverId || !body.apiKey) {
      return apiError("KEY_RESOLVE_INPUT_REQUIRED", "Missing serverId or apiKey", 400);
    }

    const config = getServer(body.serverId);
    if (!config) {
      return apiError("SERVER_NOT_FOUND", "Server not found", 404);
    }
    if (!config.authToken || !config.authUserValue) {
      return apiError("SERVER_ADMIN_CREDS_MISSING", "Server admin credentials are not configured.", 400);
    }

    const capability = getServerCapability(config);
    const adapter = getAdapter(config);
    const token = await adapter.searchToken(config, body.apiKey);
    if (!token) {
      return apiError("API_KEY_NOT_FOUND", "API key not found on this server.", 404);
    }

    const pricing = await adapter.fetchPricing(config);
    const currentGroups = normalizeSelectedGroups(normalizeGroups(token.raw), capability.groupSelectionMode);
    const availableModelCount = matchModelsByGroups(pricing.models, currentGroups, capability.groupMatchMode).length;
    return NextResponse.json({
      token: {
        id: token.id,
        name: token.name,
        key: token.key,
        remainQuota: token.remainQuota,
        usedQuota: token.usedQuota,
        currentGroups,
      },
      availableGroups: pricing.groups,
      supportsGroupChain: capability.groupSelectionMode !== "single",
      selectionMode: capability.groupSelectionMode,
      matchMode: capability.groupMatchMode,
      availableModelCount,
    });
  } catch (error) {
    console.error("Key resolve error:", error);
    return apiError("KEY_RESOLVE_FAILED", "Failed to resolve API key", 502);
  }
}

export async function PUT(request: Request) {
  const rateLimited = enforceKeyRateLimit(request, "update");
  if (rateLimited) {
    return rateLimited;
  }

  try {
    const body = (await request.json()) as { serverId?: string; apiKey?: string; groups?: string[] };
    if (!body.serverId || !body.apiKey || !Array.isArray(body.groups) || body.groups.length === 0) {
      return apiError("KEY_UPDATE_INPUT_REQUIRED", "Missing serverId, apiKey, or groups", 400);
    }

    const config = getServer(body.serverId);
    if (!config) {
      return apiError("SERVER_NOT_FOUND", "Server not found", 404);
    }
    if (!config.authToken || !config.authUserValue) {
      return apiError("SERVER_ADMIN_CREDS_MISSING", "Server admin credentials are not configured.", 400);
    }

    const capability = getServerCapability(config);
    const groups = normalizeSelectedGroups(body.groups, capability.groupSelectionMode);
    if (capability.groupSelectionMode === "single" && body.groups.length > 1) {
      return apiError("GROUP_SELECTION_INVALID", "This server allows only one group.", 400);
    }

    const adapter = getAdapter(config);
    const token = await adapter.searchToken(config, body.apiKey);
    if (!token?.raw) {
      return apiError("API_KEY_NOT_FOUND", "API key not found on this server.", 404);
    }

    const payload = buildUpdatePayload(capability.tokenUpdateMode, token.raw, groups);
    if (!payload) {
      return apiError(
        "TOKEN_UPDATE_UNSUPPORTED",
        "This server is configured with a custom token update mode and needs an explicit adapter override.",
        400,
      );
    }

    const updateRes = await fetch(joinUrl(config.baseUrl, config.tokenUpdatePath, "/api/token/"), {
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
      return apiError(
        "TOKEN_UPDATE_FAILED",
        (updatePayload && typeof updatePayload.message === "string" ? updatePayload.message : null) || `Update failed with status ${updateRes.status}`,
        502,
      );
    }

    return NextResponse.json({
      success: true,
      currentGroups: groups,
      tokenName: token.name,
      selectionMode: capability.groupSelectionMode,
      matchMode: capability.groupMatchMode,
    });
  } catch (error) {
    console.error("Key update error:", error);
    return apiError("KEY_UPDATE_FAILED", "Failed to update API key groups", 502);
  }
}
