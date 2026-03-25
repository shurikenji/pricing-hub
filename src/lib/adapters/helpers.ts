import type { LogEntry, LogQueryParams, PricingMode, ServerConfig, TokenSearchResult } from "../types";

export function buildHeaders(config: ServerConfig, override?: { userId?: string; accessToken?: string }): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const authMode = config.authMode ?? "header";
  const authToken = override?.accessToken || config.authToken || "";
  const authUserValue = override?.userId || config.authUserValue || "";

  if (authMode === "header") {
    if (config.authUserHeader && authUserValue) {
      headers[config.authUserHeader] = authUserValue;
    }
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
  } else if (authMode === "bearer") {
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
  } else if (authMode === "cookie" && config.authCookie) {
    headers.Cookie = config.authCookie;
  }

  return headers;
}

export function joinUrl(baseUrl: string, pathName?: string, fallback = ""): string {
  const safePath = (pathName || fallback || "").trim();
  return `${baseUrl.replace(/\/$/, "")}${safePath.startsWith("/") ? safePath : `/${safePath}`}`;
}

export function buildTokenSearchCandidates(apiKey: string): Array<{ keyword: string; token: string }> {
  const stripped = apiKey.startsWith("sk-") ? apiKey.slice(3) : apiKey;
  const keywordHint = stripped.length > 8 ? stripped.slice(-8) : stripped;
  const candidates = [
    { keyword: "", token: apiKey },
    { keyword: "", token: stripped },
    { keyword: keywordHint, token: apiKey },
  ];

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.keyword}:${candidate.token}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function extractTokenItems(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  }
  if (payload && typeof payload === "object") {
    for (const key of ["items", "list", "rows", "records", "data"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
      }
    }
  }
  return [];
}

export function matchTokenFromItems(items: Record<string, unknown>[], requestedToken: string): TokenSearchResult | null {
  const normalizedRequested = requestedToken.startsWith("sk-") ? requestedToken.slice(3) : requestedToken;

  for (const item of items) {
    const rawKey = String(item.key || "");
    const normalized = rawKey.startsWith("sk-") ? rawKey.slice(3) : rawKey;
    if (rawKey === requestedToken || normalized === normalizedRequested) {
      return {
        id: typeof item.id === "number" ? item.id : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        key: rawKey || undefined,
        remainQuota: typeof item.remain_quota === "number" ? item.remain_quota : undefined,
        usedQuota: typeof item.used_quota === "number" ? item.used_quota : typeof item.usedQuota === "number" ? item.usedQuota : undefined,
        raw: item,
      };
    }
  }

  if (items.length === 1) {
    const item = items[0];
    return {
      id: typeof item.id === "number" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      key: typeof item.key === "string" ? item.key : undefined,
      remainQuota: typeof item.remain_quota === "number" ? item.remain_quota : undefined,
      usedQuota: typeof item.used_quota === "number" ? item.used_quota : undefined,
      raw: item,
    };
  }

  return null;
}

export function inferPricingMode(quotaType: number | undefined, modelPrice?: number, modelRatio?: number, completionRatio?: number): PricingMode {
  if (quotaType === 1) {
    return "request_scaled";
  }
  if ((modelRatio || 0) > 0 || (completionRatio || 0) > 0) {
    return "token";
  }
  if ((modelPrice || 0) > 0) {
    return "fixed";
  }
  return "unknown";
}

export function estimateLogUsd(entry: Pick<LogEntry, "quotaType" | "groupRatio" | "modelRatio" | "completionRatio" | "promptTokens" | "completionTokens" | "modelPrice">): number | undefined {
  const mode = inferPricingMode(entry.quotaType, entry.modelPrice, entry.modelRatio, entry.completionRatio);
  if (mode === "request_scaled" && (entry.modelPrice || 0) > 0) {
    return Number((((entry.groupRatio || 1) * (entry.modelPrice || 0))).toFixed(6));
  }
  if (mode === "fixed" && (entry.modelPrice || 0) > 0) {
    return Number((entry.modelPrice || 0).toFixed(6));
  }
  if (mode === "token" && (entry.modelRatio || 0) > 0) {
    return Number((((entry.groupRatio || 1) * (entry.modelRatio || 0) * ((entry.promptTokens || 0) + (entry.completionTokens || 0) * (entry.completionRatio || 1))) / 500000).toFixed(6));
  }
  return undefined;
}

export function buildLogUrl(config: ServerConfig, params: LogQueryParams): string {
  const url = new URL(joinUrl(config.baseUrl, config.logPath, "/api/log/self"));
  url.searchParams.set("p", String(params.page || 1));
  url.searchParams.set("page_size", String(params.pageSize || 50));
  url.searchParams.set("type", "0");
  if (params.tokenName) url.searchParams.set("token_name", params.tokenName);
  if (params.modelName) url.searchParams.set("model_name", params.modelName);
  if (params.startTimestamp) url.searchParams.set("start_timestamp", String(params.startTimestamp));
  if (params.endTimestamp) url.searchParams.set("end_timestamp", String(params.endTimestamp));
  if (params.group) url.searchParams.set("group", params.group);
  return url.toString();
}
