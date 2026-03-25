export type ServerType = "newapi" | "rixapi" | "custom";
export type AuthMode = "header" | "bearer" | "cookie" | "none";
export type PricingMode = "token" | "request_scaled" | "fixed" | "unknown";

export interface EndpointSpec {
  type: string;
  method?: string;
  path?: string;
  docs?: string;
  description?: string;
}

export interface GroupPriceSnapshot {
  groupName: string;
  groupRatio: number;
  pricingMode: PricingMode;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  cachedInputPricePer1M?: number;
  requestPrice?: number;
}

export interface NormalizedModel {
  modelName: string;
  vendorId?: number;
  vendorName?: string;
  quotaType: number;
  pricingMode: PricingMode;
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  createCacheRatio?: number;
  audioRatio?: number;
  audioCompletionRatio?: number;
  imageRatio?: number;
  modelPrice: number;
  enableGroups: string[];
  supportedEndpoints: string[];
  endpointDetails?: EndpointSpec[];
  description?: string;
  icon?: string;
  tags?: string;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  cachedInputPricePer1M?: number;
  requestPrice?: number;
  groupPrices?: Record<string, GroupPriceSnapshot>;
}

export interface NormalizedGroup {
  name: string;
  displayName: string;
  ratio: number;
  description?: string;
}

export interface NormalizedPricing {
  models: NormalizedModel[];
  groups: NormalizedGroup[];
  autoGroups?: string[];
  serverName: string;
  fetchedAt: number;
}

export interface LogEntry {
  id: number;
  createdAt: number;
  model: string;
  group: string;
  tokenName: string;
  promptTokens: number;
  completionTokens: number;
  quota: number;
  useTime: number;
  isStream: boolean;
  requestPath?: string;
  groupRatio?: number;
  modelRatio?: number;
  completionRatio?: number;
  cacheTokens?: number;
  cacheRatio?: number;
  modelPrice?: number;
  quotaType?: number;
  pricingMode?: PricingMode;
  estimatedUsd?: number;
  notes?: string[];
}

export interface LogResponse {
  items: LogEntry[];
  total: number;
  page: number;
  pageSize: number;
  resolvedByApiKey?: boolean;
  resolvedTokenName?: string;
  resolutionWarning?: string;
}

export interface ServerConfig {
  id: string;
  name: string;
  baseUrl: string;
  type: ServerType;
  supportsGroupChain: boolean;
  ratioConfigEnabled: boolean;
  enabled: boolean;
  authMode?: AuthMode;
  authUserHeader?: string;
  authUserValue?: string;
  authToken?: string;
  authCookie?: string;
  pricingPath?: string;
  ratioConfigPath?: string;
  logPath?: string;
  tokenSearchPath?: string;
  groupsPath?: string;
  notes?: string;
}

export interface ServerAdapter {
  fetchPricing(config: ServerConfig): Promise<NormalizedPricing>;
  fetchLogs(config: ServerConfig, params: LogQueryParams): Promise<LogResponse>;
  searchToken(config: ServerConfig, apiKey: string): Promise<TokenSearchResult | null>;
}

export interface LogQueryParams {
  userId?: string;
  accessToken?: string;
  page?: number;
  pageSize?: number;
  tokenName?: string;
  modelName?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  group?: string;
}

export interface PricingRequest {
  serverId: string;
  groupFilter?: string[];
}

export interface LogRequest {
  serverId: string;
  apiKey?: string;
  userId?: string;
  accessToken?: string;
  page?: number;
  pageSize?: number;
  tokenName?: string;
  modelName?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  group?: string;
}

export interface TokenSearchResult {
  id?: number;
  name?: string;
  key?: string;
  remainQuota?: number;
  usedQuota?: number;
  raw: Record<string, unknown>;
}

export interface ResolvedTokenProfile {
  id?: number;
  name?: string;
  key?: string;
  remainQuota?: number;
  usedQuota?: number;
  currentGroups: string[];
}

export interface KeyResolveResponse {
  token: ResolvedTokenProfile;
  availableGroups: NormalizedGroup[];
  supportsGroupChain: boolean;
}

export interface AdminAuditLog {
  id: number;
  action: string;
  targetType: string;
  targetId?: string;
  detail?: string;
  createdAt: number;
}

export interface PricingSnapshotSummary {
  id: number;
  serverId: string;
  serverName: string;
  modelCount: number;
  groupCount: number;
  fetchedAt: number;
}
