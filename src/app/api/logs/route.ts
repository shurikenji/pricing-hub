import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { getServer } from "@/lib/servers";
import { getAdapter } from "@/lib/adapters";
import { consumeRateLimit, getClientIdentifier } from "@/lib/rate-limit";
import { getServerCapability } from "@/lib/server-capabilities";
import type { LogQueryParams, LogRequest } from "@/lib/types";

export async function POST(request: Request) {
  const ip = getClientIdentifier(request);
  const bucket = consumeRateLimit(`logs:${ip}`, 20, 60_000);
  if (!bucket.allowed) {
    return apiError("RATE_LIMITED", "Too many log lookups. Please retry shortly.", 429);
  }

  try {
    const body = (await request.json()) as LogRequest;
    const { serverId, apiKey, userId, accessToken, ...queryParams } = body;

    if (!serverId) {
      return apiError("SERVER_REQUIRED", "Missing serverId", 400);
    }

    const config = getServer(serverId);
    if (!config) {
      return apiError("SERVER_NOT_FOUND", "Server not found", 404);
    }

    const adapter = getAdapter(config);
    const capability = getServerCapability(config);
    const params: LogQueryParams = {
      userId,
      accessToken,
      ...queryParams,
    };

    let resolvedByApiKey = false;
    let resolvedTokenName: string | undefined;
    let resolutionWarning: string | undefined;

    if (apiKey && !params.tokenName) {
      if (capability.logResolveMode === "direct_credentials") {
        return apiError(
          "LOG_RESOLVE_DIRECT_CREDS_REQUIRED",
          "This server is configured for direct credentials only. Provide userId and accessToken instead of API key.",
          400,
        );
      }
      if (!config.authToken || !config.authUserValue) {
        return apiError(
          "SERVER_ADMIN_CREDS_MISSING",
          "This server does not have admin credentials configured for API-key-based log lookup.",
          400,
        );
      }

      const token = await adapter.searchToken(config, apiKey);
      if (!token?.name) {
        return apiError("TOKEN_RESOLVE_FAILED", "Unable to resolve token name from the provided API key.", 404);
      }

      params.tokenName = token.name;
      params.userId = config.authUserValue;
      params.accessToken = config.authToken;
      resolvedByApiKey = true;
      resolvedTokenName = token.name;
      resolutionWarning = "Usage log was resolved through server-side admin credentials. The raw admin secret is never returned to the browser.";
    }

    if (!params.userId || !params.accessToken) {
      return apiError("LOG_CREDENTIALS_REQUIRED", "Missing credentials. Provide API key or direct userId/accessToken.", 400);
    }

    const logs = await adapter.fetchLogs(config, params);
    return NextResponse.json({
      ...logs,
      resolvedByApiKey,
      resolvedTokenName,
      resolutionWarning,
    });
  } catch (err) {
    console.error("Log fetch error:", err);
    return apiError("LOG_FETCH_FAILED", "Failed to fetch logs", 502);
  }
}
