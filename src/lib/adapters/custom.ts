import type {
  LogQueryParams,
  LogResponse,
  NormalizedPricing,
  ServerAdapter,
  ServerConfig,
  TokenSearchResult,
} from "../types";
import {
  normalizeCustomLogPayload,
  normalizeCustomPricingPayload,
  normalizeCustomTokenPayload,
} from "../custom-normalizer";
import { buildHeaders, buildLogUrl, buildTokenSearchCandidates, joinUrl } from "./helpers";

export class CustomAdapter implements ServerAdapter {
  async fetchPricing(config: ServerConfig): Promise<NormalizedPricing> {
    const response = await fetch(joinUrl(config.baseUrl, config.pricingPath, "/api/pricing"), {
      headers: buildHeaders(config),
      next: { revalidate: 300 },
    });
    if (!response.ok) {
      throw new Error(`Custom pricing fetch failed: ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    return normalizeCustomPricingPayload(payload, config);
  }

  async fetchLogs(config: ServerConfig, params: LogQueryParams): Promise<LogResponse> {
    const response = await fetch(buildLogUrl(config, params), {
      headers: buildHeaders(config, { userId: params.userId, accessToken: params.accessToken }),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Custom log fetch failed: ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    return normalizeCustomLogPayload(payload, params, config);
  }

  async searchToken(config: ServerConfig, apiKey: string): Promise<TokenSearchResult | null> {
    const searchUrl = joinUrl(config.baseUrl, config.tokenSearchPath, "/api/token/search");

    for (const candidate of buildTokenSearchCandidates(apiKey)) {
      const url = new URL(searchUrl);
      if (candidate.keyword) {
        url.searchParams.set("keyword", candidate.keyword);
      }
      url.searchParams.set("token", candidate.token);

      const response = await fetch(url.toString(), {
        headers: buildHeaders(config),
        cache: "no-store",
      });
      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as unknown;
      const matched = normalizeCustomTokenPayload(payload, candidate.token, config);
      if (matched) {
        return matched;
      }
    }

    return null;
  }
}
