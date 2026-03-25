import type {
  GroupPriceSnapshot,
  LogEntry,
  LogQueryParams,
  LogResponse,
  NormalizedGroup,
  NormalizedModel,
  NormalizedPricing,
  ServerAdapter,
  ServerConfig,
  TokenSearchResult,
} from "../types";
import {
  buildHeaders,
  buildLogUrl,
  buildTokenSearchCandidates,
  estimateLogUsd,
  extractTokenItems,
  inferPricingMode,
  joinUrl,
  matchTokenFromItems,
} from "./helpers";

interface NewApiPricingItem {
  model_name: string;
  vendor_id?: number;
  quota_type: number;
  model_ratio: number;
  model_price: number;
  completion_ratio: number;
  cache_ratio?: number;
  create_cache_ratio?: number;
  audio_ratio?: number;
  audio_completion_ratio?: number;
  image_ratio?: number;
  enable_groups: string[];
  supported_endpoint_types?: string[];
  description?: string;
}

interface NewApiPricingResponse {
  data: NewApiPricingItem[];
  auto_groups?: string[];
}

interface NewApiRatioResponse {
  data: {
    model_ratio?: Record<string, number>;
    completion_ratio?: Record<string, number>;
    cache_ratio?: Record<string, number>;
    model_price?: Record<string, number>;
  };
  success: boolean;
}

interface NewApiLogItem {
  id: number;
  created_at: number;
  token_name: string;
  token_group: string;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
  is_stream: boolean;
  other: string;
}

interface NewApiLogResponse {
  data: {
    items: NewApiLogItem[];
    total?: number;
  };
}

function buildGroupSnapshot(
  groupName: string,
  groupRatio: number,
  quotaType: number,
  modelRatio: number,
  completionRatio: number,
  cacheRatio: number | undefined,
  modelPrice: number,
): GroupPriceSnapshot {
  const pricingMode = inferPricingMode(quotaType, modelPrice, modelRatio, completionRatio);
  const snapshot: GroupPriceSnapshot = {
    groupName,
    groupRatio,
    pricingMode,
  };

  if (pricingMode === "token") {
    snapshot.inputPricePer1M = Number((2 * groupRatio * modelRatio).toFixed(6));
    snapshot.outputPricePer1M = Number((2 * groupRatio * modelRatio * completionRatio).toFixed(6));
    if (cacheRatio !== undefined) {
      snapshot.cachedInputPricePer1M = Number((2 * groupRatio * modelRatio * cacheRatio).toFixed(6));
    }
  } else if (pricingMode === "request_scaled" && modelPrice > 0) {
    snapshot.requestPrice = Number((groupRatio * modelPrice).toFixed(6));
  } else if (pricingMode === "fixed" && modelPrice > 0) {
    snapshot.requestPrice = Number(modelPrice.toFixed(6));
  }

  return snapshot;
}

export class NewApiAdapter implements ServerAdapter {
  async fetchPricing(config: ServerConfig): Promise<NormalizedPricing> {
    const pricingRes = await fetch(joinUrl(config.baseUrl, config.pricingPath, "/api/pricing"), {
      next: { revalidate: 300 },
    });
    if (!pricingRes.ok) {
      throw new Error(`Pricing fetch failed: ${pricingRes.status}`);
    }
    const pricingData: NewApiPricingResponse = await pricingRes.json();

    let ratioData: NewApiRatioResponse["data"] | null = null;
    if (config.ratioConfigEnabled) {
      try {
        const ratioRes = await fetch(joinUrl(config.baseUrl, config.ratioConfigPath, "/api/ratio_config"), {
          next: { revalidate: 300 },
        });
        if (ratioRes.ok) {
          const ratioJson: NewApiRatioResponse = await ratioRes.json();
          if (ratioJson.success) {
            ratioData = ratioJson.data;
          }
        }
      } catch {
        ratioData = null;
      }
    }

    const groupSet = new Set<string>();
    for (const item of pricingData.data ?? []) {
      for (const groupName of item.enable_groups ?? []) {
        groupSet.add(groupName);
      }
    }

    const groups: NormalizedGroup[] = Array.from(groupSet)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        displayName: name,
        ratio: 1,
        description: config.ratioConfigEnabled
          ? "Public pricing does not always expose group ratio. Normalized snapshot uses the best public values available."
          : "Group ratio is not exposed by this server.",
      }));

    const models: NormalizedModel[] = (pricingData.data ?? []).map((item) => {
      const modelRatio = ratioData?.model_ratio?.[item.model_name] ?? item.model_ratio ?? 0;
      const completionRatio = ratioData?.completion_ratio?.[item.model_name] ?? item.completion_ratio ?? 1;
      const cacheRatio = ratioData?.cache_ratio?.[item.model_name] ?? item.cache_ratio;
      const modelPrice = ratioData?.model_price?.[item.model_name] ?? item.model_price ?? 0;
      const quotaType = item.quota_type ?? 0;
      const pricingMode = inferPricingMode(quotaType, modelPrice, modelRatio, completionRatio);

      const groupPrices = Object.fromEntries(
        (item.enable_groups ?? []).map((groupName) => [
          groupName,
          buildGroupSnapshot(groupName, 1, quotaType, modelRatio, completionRatio, cacheRatio, modelPrice),
        ]),
      );

      const baseSnapshot = item.enable_groups?.length
        ? groupPrices[item.enable_groups[0]]
        : buildGroupSnapshot("default", 1, quotaType, modelRatio, completionRatio, cacheRatio, modelPrice);

      return {
        modelName: item.model_name,
        vendorId: item.vendor_id,
        quotaType,
        pricingMode,
        modelRatio,
        completionRatio,
        cacheRatio,
        createCacheRatio: item.create_cache_ratio,
        audioRatio: item.audio_ratio,
        audioCompletionRatio: item.audio_completion_ratio,
        imageRatio: item.image_ratio,
        modelPrice,
        enableGroups: item.enable_groups ?? [],
        supportedEndpoints: item.supported_endpoint_types ?? [],
        endpointDetails: (item.supported_endpoint_types ?? []).map((type) => ({ type })),
        description: item.description,
        inputPricePer1M: baseSnapshot.inputPricePer1M,
        outputPricePer1M: baseSnapshot.outputPricePer1M,
        cachedInputPricePer1M: baseSnapshot.cachedInputPricePer1M,
        requestPrice: baseSnapshot.requestPrice,
        groupPrices,
      };
    });

    return {
      models,
      groups,
      autoGroups: pricingData.auto_groups,
      serverName: config.name,
      fetchedAt: Date.now(),
    };
  }

  async fetchLogs(config: ServerConfig, params: LogQueryParams): Promise<LogResponse> {
    const res = await fetch(buildLogUrl(config, params), {
      headers: buildHeaders(config, { userId: params.userId, accessToken: params.accessToken }),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Log fetch failed: ${res.status}`);
    }

    const raw: NewApiLogResponse = await res.json();
    const items: LogEntry[] = (raw.data?.items ?? []).map((item) => {
      let other: Record<string, unknown> = {};
      try {
        other = JSON.parse(item.other || "{}");
      } catch {
        other = {};
      }

      const quotaType = typeof other.quota_type === "number" ? other.quota_type : undefined;
      const logEntry: LogEntry = {
        id: item.id,
        createdAt: item.created_at,
        model: item.model_name,
        group: item.token_group,
        tokenName: item.token_name,
        promptTokens: item.prompt_tokens,
        completionTokens: item.completion_tokens,
        quota: item.quota,
        useTime: item.use_time,
        isStream: item.is_stream,
        requestPath: typeof other.request_path === "string" ? other.request_path : undefined,
        groupRatio: typeof other.group_ratio === "number" ? other.group_ratio : undefined,
        modelRatio: typeof other.model_ratio === "number" ? other.model_ratio : undefined,
        completionRatio: typeof other.completion_ratio === "number" ? other.completion_ratio : undefined,
        cacheTokens: typeof other.cache_tokens === "number" ? other.cache_tokens : undefined,
        cacheRatio: typeof other.cache_ratio === "number" ? other.cache_ratio : undefined,
        modelPrice: typeof other.model_price === "number" ? other.model_price : undefined,
        quotaType,
      };
      logEntry.pricingMode = inferPricingMode(quotaType, logEntry.modelPrice, logEntry.modelRatio, logEntry.completionRatio);
      logEntry.estimatedUsd = estimateLogUsd(logEntry);
      return logEntry;
    });

    return {
      items,
      total: raw.data?.total ?? items.length,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 50,
    };
  }

  async searchToken(config: ServerConfig, apiKey: string): Promise<TokenSearchResult | null> {
    const searchUrl = joinUrl(config.baseUrl, config.tokenSearchPath, "/api/token/search");

    for (const candidate of buildTokenSearchCandidates(apiKey)) {
      const url = new URL(searchUrl);
      if (candidate.keyword) {
        url.searchParams.set("keyword", candidate.keyword);
      }
      url.searchParams.set("token", candidate.token);

      const res = await fetch(url.toString(), {
        headers: buildHeaders(config),
        cache: "no-store",
      });
      if (!res.ok) {
        continue;
      }

      const payload = (await res.json()) as { success?: boolean; data?: unknown };
      if (!payload?.success) {
        continue;
      }

      const items = extractTokenItems(payload.data);
      const matched = matchTokenFromItems(items, candidate.token);
      if (matched) {
        return matched;
      }
    }

    return null;
  }
}
