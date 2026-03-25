export type PriceMode = "token" | "request_scaled" | "fixed" | "unknown";

export type PricingSourceType =
  | "separate_ratio_endpoint"
  | "inline_group_ratio"
  | "inline_model_price"
  | "hybrid"
  | "custom_formula";

export type GroupSelectionMode = "single" | "multi_union" | "multi_intersection" | "chain";

export interface NormalizedGroup {
  key: string;
  label: string;
  description: string;
  ratio: number;
}

export interface NormalizedEndpoint {
  key: string;
  method: string;
  path: string;
  docsUrl?: string | null;
  description?: string;
}

export interface NormalizedPricePoint {
  groupKey: string;
  groupLabel: string;
  groupRatio: number;
  mode: PriceMode;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  cachedInputUsdPer1M?: number;
  requestUsd?: number;
  modelRatio?: number;
  completionRatio?: number;
  cacheRatio?: number;
  modelPrice?: number;
  quotaType?: number | null;
  notes?: string[];
}

export interface NormalizedModel {
  name: string;
  displayName: string;
  vendor?: string;
  description?: string;
  tags: string[];
  availableGroupKeys: string[];
  endpoints: NormalizedEndpoint[];
  supportedEndpointTypes: string[];
  pricePoints: NormalizedPricePoint[];
  sourceNotes: string[];
}

export interface ServerCapabilities {
  apiType: string;
  pricingSourceType: PricingSourceType;
  groupSelectionMode: GroupSelectionMode;
  supportsMultiGroup: boolean;
  supportsGroupChain: boolean;
  supportsUsageLog: boolean;
  requiresSecondaryRatioFetch: boolean;
}

export interface NormalizedPricingCatalog {
  serverId: string;
  displayName: string;
  groups: NormalizedGroup[];
  models: NormalizedModel[];
  capabilities: ServerCapabilities;
  notes: string[];
}

export interface UsageEvidence {
  quotaType?: number | null;
  modelRatio?: number;
  completionRatio?: number;
  cacheRatio?: number;
  modelPrice?: number;
  groupRatio?: number;
  requestPath?: string;
  userModelRatio?: number;
}

export interface NormalizedUsageEntry {
  requestId: string;
  responseId?: string;
  modelName: string;
  tokenName: string;
  groupKey: string;
  observedQuota: number;
  promptTokens: number;
  completionTokens: number;
  durationSeconds: number;
  mode: PriceMode;
  estimatedRequestUsd?: number;
  requestPath?: string;
  createdAtUnix: number;
  evidence: UsageEvidence;
  notes: string[];
}

export interface UsagePreview {
  serverId: string;
  totalRequests: number;
  tokenBasedRequests: number;
  requestScaledRequests: number;
  fixedRequests: number;
  totalEstimatedUsd: number;
  topModels: Array<{ modelName: string; requests: number }>;
  entries: NormalizedUsageEntry[];
}

export interface KeyManagerPreview {
  serverId: string;
  selectedGroups: string[];
  groupSelectionMode: GroupSelectionMode;
  availableModelCount: number;
  sampleModels: string[];
  notes: string[];
}
