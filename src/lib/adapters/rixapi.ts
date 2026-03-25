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

interface RixGroupInfo {
  Description?: string;
  DisplayName?: string;
  GroupRatio?: number;
}

interface RixPriceDetail {
  quota_type?: number;
  model_price?: number;
  model_ratio?: number;
  model_completion_ratio?: number;
  model_create_cache_ratio?: number;
  model_cache_ratio?: number;
  model_audio_ratio?: number;
  model_audio_completion_ratio?: number;
}

interface RixModelInfo {
  model_name: string;
  description?: string;
  icon?: string;
  tags?: string;
  vendor_id?: number;
  price_info?: Record<string, { default?: RixPriceDetail }>;
  enable_groups?: string[];
  supported_endpoint_types?: string[] | null;
  endpoints?: Array<{ type?: string; method?: string; path?: string; description?: string }>;
}

interface RixPricingResponse {
  data: {
    group_info?: Record<string, RixGroupInfo>;
    model_info?: RixModelInfo[];
  };
}

interface RixLogItem {
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

interface RixLogResponse {
  data: {
    items: RixLogItem[];
    total?: number;
  };
}

function buildGroupSnapshot(groupName: string, groupRatio: number, detail: RixPriceDetail | undefined): GroupPriceSnapshot {
  const quotaType = detail?.quota_type ?? 0;
  const modelRatio = detail?.model_ratio ?? 0;
  const completionRatio = detail?.model_completion_ratio ?? 1;
  const cacheRatio = detail?.model_cache_ratio;
  const modelPrice = detail?.model_price ?? 0;
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

export class RixApiAdapter implements ServerAdapter {
  async fetchPricing(config: ServerConfig): Promise<NormalizedPricing> {
    const res = await fetch(joinUrl(config.baseUrl, config.pricingPath, "/api/pricing"), {
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      throw new Error(`RixAPI pricing fetch failed: ${res.status}`);
    }

    const data: RixPricingResponse = await res.json();
    const groups: NormalizedGroup[] = Object.entries(data.data.group_info ?? {})
      .map(([name, info]) => ({
        name,
        displayName: info.DisplayName || name,
        ratio: info.GroupRatio ?? 1,
        description: info.Description || "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const groupRatioMap = Object.fromEntries(groups.map((group) => [group.name, group.ratio]));

    const models: NormalizedModel[] = (data.data.model_info ?? []).map((item) => {
      const candidateGroups = item.enable_groups?.length ? item.enable_groups : Object.keys(item.price_info ?? {});
      const defaultPrice = item.price_info?.default?.default;

      const groupPrices = Object.fromEntries(
        candidateGroups.map((groupName) => {
          const detail = item.price_info?.[groupName]?.default ?? defaultPrice;
          return [groupName, buildGroupSnapshot(groupName, groupRatioMap[groupName] ?? 1, detail)];
        }),
      );

      const baseGroupName = candidateGroups[0] ?? "default";
      const baseDetail = item.price_info?.[baseGroupName]?.default ?? defaultPrice;
      const baseSnapshot = groupPrices[baseGroupName] ?? buildGroupSnapshot(baseGroupName, groupRatioMap[baseGroupName] ?? 1, baseDetail);

      const quotaType = baseDetail?.quota_type ?? 0;
      const modelRatio = baseDetail?.model_ratio ?? 0;
      const completionRatio = baseDetail?.model_completion_ratio ?? 1;
      const cacheRatio = baseDetail?.model_cache_ratio;
      const modelPrice = baseDetail?.model_price ?? 0;

      return {
        modelName: item.model_name,
        vendorId: item.vendor_id,
        quotaType,
        pricingMode: inferPricingMode(quotaType, modelPrice, modelRatio, completionRatio),
        modelRatio,
        completionRatio,
        cacheRatio,
        createCacheRatio: baseDetail?.model_create_cache_ratio,
        audioRatio: baseDetail?.model_audio_ratio,
        audioCompletionRatio: baseDetail?.model_audio_completion_ratio,
        modelPrice,
        enableGroups: candidateGroups,
        supportedEndpoints: item.supported_endpoint_types ?? [],
        endpointDetails: (item.endpoints ?? []).map((endpoint) => ({
          type: endpoint.type || "custom",
          method: endpoint.method,
          path: endpoint.path,
          description: endpoint.description,
        })),
        description: item.description,
        icon: item.icon,
        tags: item.tags,
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
      throw new Error(`RixAPI log fetch failed: ${res.status}`);
    }

    const raw: RixLogResponse = await res.json();
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
