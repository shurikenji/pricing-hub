import type {
  GroupMatchMode,
  GroupSelectionMode,
  LogResolveMode,
  NormalizedModel,
  ServerCapability,
  ServerConfig,
  TokenSearchMode,
  TokenUpdateMode,
} from "./types";

function deriveSelectionMode(config: ServerConfig): GroupSelectionMode {
  if (config.groupSelectionMode) {
    return config.groupSelectionMode;
  }
  if (config.type === "rixapi" || config.supportsGroupChain) {
    return "chain";
  }
  return "single";
}

function deriveMatchMode(selectionMode: GroupSelectionMode, config: ServerConfig): GroupMatchMode {
  if (config.groupMatchMode) {
    return config.groupMatchMode;
  }
  return selectionMode === "multi_intersection" ? "intersection" : "union";
}

function deriveTokenUpdateMode(config: ServerConfig): TokenUpdateMode {
  if (config.tokenUpdateMode) {
    return config.tokenUpdateMode;
  }
  if (config.type === "rixapi") {
    return "rixapi_put";
  }
  if (config.type === "newapi") {
    return "newapi_put";
  }
  return "custom";
}

function deriveTokenSearchMode(config: ServerConfig): TokenSearchMode {
  if (config.tokenSearchMode) {
    return config.tokenSearchMode;
  }
  return "search_by_keyword_then_match";
}

function deriveLogResolveMode(config: ServerConfig): LogResolveMode {
  if (config.logResolveMode) {
    return config.logResolveMode;
  }
  return "token_name_lookup";
}

export function getServerCapability(config: ServerConfig): ServerCapability {
  const groupSelectionMode = deriveSelectionMode(config);
  return {
    groupSelectionMode,
    groupMatchMode: deriveMatchMode(groupSelectionMode, config),
    tokenUpdateMode: deriveTokenUpdateMode(config),
    tokenSearchMode: deriveTokenSearchMode(config),
    logResolveMode: deriveLogResolveMode(config),
  };
}

export function allowsMultipleGroups(selectionMode: GroupSelectionMode) {
  return selectionMode !== "single";
}

export function isIntersectionMode(selectionMode: GroupSelectionMode, matchMode: GroupMatchMode) {
  return selectionMode === "multi_intersection" || matchMode === "intersection";
}

export function matchModelsByGroups(models: NormalizedModel[], groups: string[], matchMode: GroupMatchMode) {
  if (groups.length === 0) {
    return models;
  }

  return models.filter((model) =>
    matchMode === "intersection"
      ? groups.every((group) => model.enableGroups.includes(group))
      : groups.some((group) => model.enableGroups.includes(group)),
  );
}

export function normalizeSelectedGroups(groups: string[], selectionMode: GroupSelectionMode) {
  const uniqueGroups = Array.from(new Set(groups.filter(Boolean)));
  return selectionMode === "single" ? uniqueGroups.slice(0, 1) : uniqueGroups;
}

export function validateServerConfigCapabilities(config: ServerConfig): string[] {
  const capability = getServerCapability(config);
  const errors: string[] = [];

  if (capability.groupSelectionMode === "single" && config.supportsGroupChain) {
    errors.push("supportsGroupChain cannot be enabled when groupSelectionMode is single.");
  }
  if (capability.groupSelectionMode !== "single" && !config.supportsGroupChain) {
    errors.push("supportsGroupChain should be enabled when multi-group selection is configured.");
  }
  if (config.type === "newapi" && capability.tokenUpdateMode === "rixapi_put") {
    errors.push("newapi servers cannot use rixapi_put token update mode.");
  }
  if (config.type === "rixapi" && capability.tokenUpdateMode === "newapi_put") {
    errors.push("rixapi servers cannot use newapi_put token update mode.");
  }

  return errors;
}
