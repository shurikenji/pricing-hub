export type ServerType = "newapi" | "rixapi" | "custom";
export type AuthMode = "header" | "bearer" | "cookie" | "none";
export type PricingMode = "token" | "request_scaled" | "fixed" | "unknown";
export type ServerPresetId = "newapi_standard" | "rixapi_inline" | "custom_manual";
export type GroupSelectionMode = "single" | "chain" | "multi_union" | "multi_intersection";
export type GroupMatchMode = "union" | "intersection";
export type TokenUpdateMode = "newapi_put" | "rixapi_put" | "custom";
export type TokenSearchMode = "search_by_key" | "search_by_keyword_then_match" | "custom";
export type LogResolveMode = "token_name_lookup" | "direct_credentials" | "custom";
export type SamplePayloadType = "pricing" | "logs" | "token";

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

export interface PricingFetchMeta {
  source: "snapshot" | "upstream" | "stale-snapshot";
  snapshotId?: number;
  ageMs?: number;
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
  presetId?: ServerPresetId;
  supportsGroupChain: boolean;
  ratioConfigEnabled: boolean;
  enabled: boolean;
  groupSelectionMode?: GroupSelectionMode;
  groupMatchMode?: GroupMatchMode;
  tokenUpdateMode?: TokenUpdateMode;
  tokenSearchMode?: TokenSearchMode;
  logResolveMode?: LogResolveMode;
  authMode?: AuthMode;
  authUserHeader?: string;
  authUserValue?: string;
  authToken?: string;
  authCookie?: string;
  pricingPath?: string;
  ratioConfigPath?: string;
  logPath?: string;
  tokenSearchPath?: string;
  tokenUpdatePath?: string;
  groupsPath?: string;
  notes?: string;
  autoSyncEnabled?: boolean;
  autoSyncIntervalMinutes?: number;
  lastPricingSyncAt?: number;
  lastPricingSyncStatus?: "idle" | "success" | "error";
  lastPricingSyncError?: string;
  nextPricingSyncAt?: number;
  lastHealthCheckAt?: number;
  lastHealthStatus?: "unknown" | "healthy" | "degraded" | "down";
  lastHealthLatencyMs?: number;
  lastHealthHttpStatus?: number;
  lastHealthMessage?: string;
  lastNormalizeError?: string;
  lastSyncErrorCode?: string;
  lastSyncModelCount?: number;
  lastSyncGroupCount?: number;
  normalizerHintJson?: string;
}

export interface ServerCapability {
  groupSelectionMode: GroupSelectionMode;
  groupMatchMode: GroupMatchMode;
  tokenUpdateMode: TokenUpdateMode;
  tokenSearchMode: TokenSearchMode;
  logResolveMode: LogResolveMode;
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
  selectionMode: GroupSelectionMode;
  matchMode: GroupMatchMode;
  availableModelCount?: number;
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

export interface PricingSnapshotRecord extends PricingSnapshotSummary {
  pricing: NormalizedPricing;
}

export interface PricingSnapshotDiffItem {
  modelName: string;
  changeType: "added" | "removed" | "updated";
  pricingModeBefore?: PricingMode;
  pricingModeAfter?: PricingMode;
  inputBefore?: number;
  inputAfter?: number;
  outputBefore?: number;
  outputAfter?: number;
  requestBefore?: number;
  requestAfter?: number;
  groupsBefore: string[];
  groupsAfter: string[];
}

export interface PricingSnapshotDiff {
  serverId: string;
  serverName: string;
  baseSnapshotId: number;
  compareSnapshotId: number;
  baseFetchedAt: number;
  compareFetchedAt: number;
  addedCount: number;
  removedCount: number;
  updatedCount: number;
  unchangedCount: number;
  items: PricingSnapshotDiffItem[];
}

export interface PricingSyncRunItem {
  serverId: string;
  serverName: string;
  success: boolean;
  mode?: "persisted" | "dry_run";
  snapshotId?: number;
  modelCount?: number;
  groupCount?: number;
  fetchedAt?: number;
  error?: string;
  errorCode?: string;
  diff?: PricingSnapshotDiff | null;
}

export interface PricingSyncRunResponse {
  ranAt: number;
  triggeredCount: number;
  successCount: number;
  failureCount: number;
  items: PricingSyncRunItem[];
}

export interface AdminBackupBundle {
  version: 1;
  exportedAt: number;
  servers: ServerConfig[];
  pricingSnapshots: PricingSnapshotSummary[];
  samples?: ServerSamplePayload[];
}

export interface BackupImportResponse {
  importedServers: number;
  removedServers: number;
  skippedSnapshotSummaries: number;
  importedSamples?: number;
}

export interface ServerHealthResult {
  serverId: string;
  serverName: string;
  status: "healthy" | "degraded" | "down";
  checkedAt: number;
  latencyMs: number;
  httpStatus?: number;
  message: string;
}

export interface ServerHealthRunResponse {
  checkedAt: number;
  checkedCount: number;
  healthyCount: number;
  degradedCount: number;
  downCount: number;
  items: ServerHealthResult[];
}

export interface ServerHealthHistoryEntry extends ServerHealthResult {
  id: number;
}

export interface ServerPreset {
  id: ServerPresetId;
  label: string;
  description: string;
  config: Partial<ServerConfig>;
}

export interface ServerSamplePayload {
  id: string;
  serverId: string;
  sampleType: SamplePayloadType;
  label: string;
  notes?: string;
  payloadJson: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface NormalizerPreviewDiagnostics {
  sourceServerId?: string;
  pricingModelCount: number;
  pricingGroupCount: number;
  logRowCount: number;
  trimmedModelCount: number;
  trimmedLogCount: number;
  detectedModes: Partial<Record<PricingMode, number>>;
  unresolvedWarnings: string[];
}
