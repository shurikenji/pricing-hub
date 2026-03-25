import { buildHeaders, joinUrl } from "./adapters/helpers";
import type { ServerConfig, ServerHealthResult } from "./types";

const HEALTH_TIMEOUT_MS = 10_000;

export async function runServerHealthCheck(config: ServerConfig): Promise<ServerHealthResult> {
  const url = joinUrl(config.baseUrl, config.pricingPath, "/api/pricing");
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(config),
      cache: "no-store",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const status = response.ok ? "healthy" : response.status === 401 || response.status === 403 ? "degraded" : "down";
    const message = response.ok
      ? `Pricing endpoint responded successfully`
      : `HTTP ${response.status} from ${config.pricingPath || "/api/pricing"}`;

    return {
      serverId: config.id,
      serverName: config.name,
      status,
      checkedAt: Date.now(),
      latencyMs,
      httpStatus: response.status,
      message,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Timed out after ${HEALTH_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : "Failed to reach upstream server";

    return {
      serverId: config.id,
      serverName: config.name,
      status: "down",
      checkedAt: Date.now(),
      latencyMs,
      message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
