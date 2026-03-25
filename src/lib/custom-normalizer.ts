import type {
  GroupPriceSnapshot,
  LogEntry,
  LogQueryParams,
  LogResponse,
  NormalizedGroup,
  NormalizedModel,
  NormalizedPricing,
  ServerConfig,
  TokenSearchResult,
} from "./types";
import {
  buildTokenSearchCandidates,
  estimateLogUsd,
  extractTokenItems,
  inferPricingMode,
  matchTokenFromItems,
} from "./adapters/helpers";

export interface CustomNormalizerHints {
  pricingDataPath?: string;
  groupDataPath?: string;
  groupInfoPath?: string;
  logItemsPath?: string;
  tokenItemsPath?: string;
  modelNameField?: string;
  quotaTypeField?: string;
  modelRatioField?: string;
  completionRatioField?: string;
  cacheRatioField?: string;
  modelPriceField?: string;
  enableGroupsField?: string;
  supportedEndpointsField?: string;
  descriptionField?: string;
  vendorIdField?: string;
  groupNameField?: string;
  groupDisplayNameField?: string;
  groupRatioField?: string;
  groupDescriptionField?: string;
  groupPriceMapPath?: string;
  groupPriceValuePath?: string;
  requestScaledQuotaType?: number;
}

export function parseCustomNormalizerHints(input?: Pick<ServerConfig, "normalizerHintJson"> | string | null): CustomNormalizerHints {
  const source = typeof input === "string" ? input : input?.normalizerHintJson;
  if (!source?.trim()) {
    return {};
  }

  return JSON.parse(source) as CustomNormalizerHints;
}

function readPath(input: unknown, path?: string): unknown {
  if (!path?.trim()) {
    return input;
  }

  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  return normalized.split(".").filter(Boolean).reduce<unknown>((current, key) => {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(key);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === "object") {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, input);
}

function readNumber(record: Record<string, unknown>, field?: string, fallback = 0) {
  const value = field ? readPath(record, field) : undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  return fallback;
}

function readString(record: Record<string, unknown>, field?: string) {
  const value = field ? readPath(record, field) : undefined;
  return typeof value === "string" ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, field?: string): string[] {
  const value = field ? readPath(record, field) : undefined;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return { __key: key, ...(item as Record<string, unknown>) };
      }
      return { __key: key, value: item };
    });
  }
  return [];
}

function resolveQuotaType(rawQuotaType: number, hints: CustomNormalizerHints) {
  return rawQuotaType === (hints.requestScaledQuotaType ?? 1) ? 1 : rawQuotaType;
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

export function normalizeCustomPricingPayload(payload: unknown, config: Pick<ServerConfig, "name" | "normalizerHintJson">): NormalizedPricing {
  const hints = parseCustomNormalizerHints(config);
  const rawGroups = asRecordArray(readPath(payload, hints.groupDataPath || hints.groupInfoPath));
  const rawModels = asRecordArray(readPath(payload, hints.pricingDataPath || "data"));

  const groups: NormalizedGroup[] = rawGroups.map((group) => {
    const name =
      readString(group, hints.groupNameField) ||
      (typeof group.__key === "string" ? group.__key : undefined) ||
      readString(group, "name") ||
      readString(group, "group") ||
      "default";

    return {
      name,
      displayName:
        readString(group, hints.groupDisplayNameField) ||
        readString(group, "displayName") ||
        readString(group, "DisplayName") ||
        name,
      ratio: readNumber(group, hints.groupRatioField, readNumber(group, "GroupRatio", 1)),
      description:
        readString(group, hints.groupDescriptionField) || readString(group, "description") || readString(group, "Description"),
    };
  });

  const groupRatioMap = Object.fromEntries(groups.map((group) => [group.name, group.ratio]));

  const models: NormalizedModel[] = rawModels.map((rawModel) => {
    const modelName =
      readString(rawModel, hints.modelNameField) ||
      readString(rawModel, "model_name") ||
      readString(rawModel, "modelName") ||
      readString(rawModel, "name") ||
      "unknown-model";
    const rawQuotaType = readNumber(rawModel, hints.quotaTypeField, readNumber(rawModel, "quota_type", 0));
    const quotaType = resolveQuotaType(rawQuotaType, hints);
    const modelRatio = readNumber(rawModel, hints.modelRatioField, readNumber(rawModel, "model_ratio", 0));
    const completionRatio = readNumber(rawModel, hints.completionRatioField, readNumber(rawModel, "completion_ratio", 1));
    const cacheRatio = readNumber(rawModel, hints.cacheRatioField, readNumber(rawModel, "cache_ratio", Number.NaN));
    const modelPrice = readNumber(rawModel, hints.modelPriceField, readNumber(rawModel, "model_price", 0));
    const enableGroups = readStringArray(rawModel, hints.enableGroupsField || "enable_groups");
    const supportedEndpoints = readStringArray(rawModel, hints.supportedEndpointsField || "supported_endpoint_types");
    const groupNames = enableGroups.length > 0 ? enableGroups : groups.map((group) => group.name);
    const rawGroupPriceMap = asRecord(readPath(rawModel, hints.groupPriceMapPath));

    const groupPrices = Object.fromEntries(
      groupNames.map((groupName) => {
        const groupPriceSource = asRecord(rawGroupPriceMap?.[groupName]);
        const groupPriceValue =
          asRecord(readPath(groupPriceSource, hints.groupPriceValuePath || "default")) || groupPriceSource || {};
        const groupQuotaType = resolveQuotaType(readNumber(groupPriceValue, hints.quotaTypeField, rawQuotaType), hints);
        const groupModelRatio = readNumber(groupPriceValue, hints.modelRatioField, modelRatio);
        const groupCompletionRatio = readNumber(groupPriceValue, hints.completionRatioField, completionRatio);
        const groupCacheRatioValue = readNumber(
          groupPriceValue,
          hints.cacheRatioField,
          Number.isNaN(cacheRatio) ? Number.NaN : cacheRatio,
        );
        const groupModelPrice = readNumber(groupPriceValue, hints.modelPriceField, modelPrice);

        return [
          groupName,
          buildGroupSnapshot(
            groupName,
            groupRatioMap[groupName] ?? 1,
            groupQuotaType,
            groupModelRatio,
            groupCompletionRatio,
            Number.isNaN(groupCacheRatioValue) ? undefined : groupCacheRatioValue,
            groupModelPrice,
          ),
        ];
      }),
    );

    const baseSnapshot =
      groupNames.length > 0
        ? groupPrices[groupNames[0]]
        : buildGroupSnapshot(
            "default",
            1,
            quotaType,
            modelRatio,
            completionRatio,
            Number.isNaN(cacheRatio) ? undefined : cacheRatio,
            modelPrice,
          );

    return {
      modelName,
      vendorId: readNumber(rawModel, hints.vendorIdField, readNumber(rawModel, "vendor_id", 0)) || undefined,
      quotaType,
      pricingMode: inferPricingMode(quotaType, modelPrice, modelRatio, completionRatio),
      modelRatio,
      completionRatio,
      cacheRatio: Number.isNaN(cacheRatio) ? undefined : cacheRatio,
      modelPrice,
      enableGroups: groupNames,
      supportedEndpoints,
      endpointDetails: supportedEndpoints.map((type) => ({ type })),
      description: readString(rawModel, hints.descriptionField) || readString(rawModel, "description"),
      inputPricePer1M: baseSnapshot.inputPricePer1M,
      outputPricePer1M: baseSnapshot.outputPricePer1M,
      cachedInputPricePer1M: baseSnapshot.cachedInputPricePer1M,
      requestPrice: baseSnapshot.requestPrice,
      groupPrices,
    };
  });

  const resolvedGroups =
    groups.length > 0
      ? groups
      : Array.from(new Set(models.flatMap((model) => model.enableGroups)))
          .sort((left, right) => left.localeCompare(right))
          .map((name) => ({
            name,
            displayName: name,
            ratio: 1,
            description: "Derived from model group memberships.",
          }));

  return {
    models,
    groups: resolvedGroups,
    serverName: config.name,
    fetchedAt: Date.now(),
  };
}

export function normalizeCustomLogPayload(
  payload: unknown,
  params: LogQueryParams,
  config: Pick<ServerConfig, "normalizerHintJson">,
): LogResponse {
  const hints = parseCustomNormalizerHints(config);
  const logItemsSource =
    readPath(payload, hints.logItemsPath) ?? readPath(payload, "data.items") ?? readPath(payload, "items") ?? payload;

  const items = extractTokenItems(logItemsSource).map((item) => {
    let other: Record<string, unknown> = {};
    if (typeof item.other === "string") {
      try {
        other = JSON.parse(item.other);
      } catch {
        other = {};
      }
    } else if (item.other && typeof item.other === "object") {
      other = item.other as Record<string, unknown>;
    }

    const rawQuotaType =
      typeof other.quota_type === "number" ? other.quota_type : typeof item.quota_type === "number" ? item.quota_type : 0;
    const quotaType = resolveQuotaType(rawQuotaType, hints);

    const entry: LogEntry = {
      id: typeof item.id === "number" ? item.id : 0,
      createdAt: typeof item.created_at === "number" ? item.created_at : typeof item.createdAt === "number" ? item.createdAt : 0,
      model: String(item.model_name || item.model || ""),
      group: String(item.token_group || item.group || ""),
      tokenName: String(item.token_name || item.tokenName || ""),
      promptTokens: typeof item.prompt_tokens === "number" ? item.prompt_tokens : typeof item.promptTokens === "number" ? item.promptTokens : 0,
      completionTokens:
        typeof item.completion_tokens === "number" ? item.completion_tokens : typeof item.completionTokens === "number" ? item.completionTokens : 0,
      quota: typeof item.quota === "number" ? item.quota : 0,
      useTime: typeof item.use_time === "number" ? item.use_time : typeof item.useTime === "number" ? item.useTime : 0,
      isStream: Boolean(item.is_stream ?? item.isStream),
      requestPath: typeof other.request_path === "string" ? other.request_path : undefined,
      groupRatio: typeof other.group_ratio === "number" ? other.group_ratio : undefined,
      modelRatio: typeof other.model_ratio === "number" ? other.model_ratio : undefined,
      completionRatio: typeof other.completion_ratio === "number" ? other.completion_ratio : undefined,
      cacheTokens: typeof other.cache_tokens === "number" ? other.cache_tokens : undefined,
      cacheRatio: typeof other.cache_ratio === "number" ? other.cache_ratio : undefined,
      modelPrice: typeof other.model_price === "number" ? other.model_price : undefined,
      quotaType,
    };
    entry.pricingMode = inferPricingMode(quotaType, entry.modelPrice, entry.modelRatio, entry.completionRatio);
    entry.estimatedUsd = estimateLogUsd(entry);
    return entry;
  });

  return {
    items,
    total: typeof readPath(payload, "data.total") === "number" ? (readPath(payload, "data.total") as number) : items.length,
    page: params.page ?? 1,
    pageSize: params.pageSize ?? 50,
  };
}

export function normalizeCustomTokenPayload(
  payload: unknown,
  apiKey: string,
  config: Pick<ServerConfig, "normalizerHintJson">,
): TokenSearchResult | null {
  const hints = parseCustomNormalizerHints(config);
  const items = extractTokenItems(readPath(payload, hints.tokenItemsPath) ?? (payload as Record<string, unknown>)?.data ?? payload);

  for (const candidate of buildTokenSearchCandidates(apiKey)) {
    const matched = matchTokenFromItems(items, candidate.token);
    if (matched) {
      return matched;
    }
  }

  return null;
}
