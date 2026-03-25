import { NextResponse } from "next/server";
import { getServer } from "@/lib/servers";
import { getAdapter } from "@/lib/adapters";
import type { LogQueryParams, LogRequest } from "@/lib/types";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as LogRequest;
    const { serverId, apiKey, userId, accessToken, ...queryParams } = body;

    if (!serverId) {
      return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
    }

    const config = getServer(serverId);
    if (!config) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }

    const adapter = getAdapter(config);
    const params: LogQueryParams = {
      userId,
      accessToken,
      ...queryParams,
    };

    let resolvedByApiKey = false;
    let resolvedTokenName: string | undefined;
    let resolutionWarning: string | undefined;

    if (apiKey && !params.tokenName) {
      if (!config.authToken || !config.authUserValue) {
        return NextResponse.json(
          { error: "This server does not have admin credentials configured for API-key-based log lookup." },
          { status: 400 },
        );
      }

      const token = await adapter.searchToken(config, apiKey);
      if (!token?.name) {
        return NextResponse.json({ error: "Unable to resolve token name from the provided API key." }, { status: 404 });
      }

      params.tokenName = token.name;
      params.userId = config.authUserValue;
      params.accessToken = config.authToken;
      resolvedByApiKey = true;
      resolvedTokenName = token.name;
      resolutionWarning = "Usage log was resolved through server-side admin credentials. The raw admin secret is never returned to the browser.";
    }

    if (!params.userId || !params.accessToken) {
      return NextResponse.json(
        { error: "Missing credentials. Provide API key or direct userId/accessToken." },
        { status: 400 },
      );
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
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 502 });
  }
}
