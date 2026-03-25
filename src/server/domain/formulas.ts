import type { GroupSelectionMode, NormalizedModel, PriceMode, UsageEvidence } from "@/server/domain/types";

export interface TokenPriceInput {
  groupRatio: number;
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
}

export interface UsageEstimateInput {
  groupRatio: number;
  modelRatio: number;
  completionRatio: number;
  promptTokens: number;
  completionTokens: number;
}

const TOKEN_PRICE_DENOMINATOR = 500000;

export function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function buildTokenPrices(input: TokenPriceInput) {
  const groupRatio = input.groupRatio || 1;
  const modelRatio = input.modelRatio || 0;
  const completionRatio = input.completionRatio || 1;
  const cacheRatio = input.cacheRatio;

  return {
    inputUsdPer1M: roundUsd(2 * groupRatio * modelRatio),
    outputUsdPer1M: roundUsd(2 * groupRatio * modelRatio * completionRatio),
    cachedInputUsdPer1M:
      cacheRatio === undefined ? undefined : roundUsd(2 * groupRatio * modelRatio * cacheRatio),
  };
}

export function estimateTokenRequestUsd(input: UsageEstimateInput): number {
  return roundUsd(
    (input.groupRatio * input.modelRatio * (input.promptTokens + input.completionTokens * input.completionRatio)) /
      TOKEN_PRICE_DENOMINATOR,
  );
}

export function estimateRequestScaledUsd(groupRatio: number, modelPrice: number): number {
  return roundUsd(groupRatio * modelPrice);
}

export function inferCatalogPriceMode(config: {
  quotaType?: number | null;
  modelRatio?: number;
  completionRatio?: number;
  modelPrice?: number;
}): PriceMode {
  if (config.quotaType === 1) {
    return "request_scaled";
  }
  if ((config.modelRatio || 0) > 0 || (config.completionRatio || 0) > 0) {
    return "token";
  }
  if ((config.modelPrice || 0) > 0) {
    return "fixed";
  }
  return "unknown";
}

export function inferUsagePriceMode(params: {
  promptTokens: number;
  completionTokens: number;
  evidence: UsageEvidence;
}): PriceMode {
  const promptTokens = params.promptTokens || 0;
  const completionTokens = params.completionTokens || 0;
  const evidence = params.evidence;
  const hasTokenUsage = promptTokens > 0 || completionTokens > 0;
  const hasRatios = (evidence.modelRatio || 0) > 0 || (evidence.completionRatio || 0) > 0;

  if (evidence.quotaType === 1) {
    return "request_scaled";
  }
  if (hasTokenUsage && hasRatios) {
    return "token";
  }
  if (hasRatios) {
    return "token";
  }
  if ((evidence.modelPrice || 0) > 0) {
    return "fixed";
  }
  return "unknown";
}

export function selectModelsByGroups(
  models: NormalizedModel[],
  selectedGroups: string[],
  mode: GroupSelectionMode,
): NormalizedModel[] {
  if (selectedGroups.length === 0) {
    return [];
  }

  return models.filter((model) => {
    const groups = new Set(model.availableGroupKeys);
    if (mode === "multi_intersection" || mode === "chain") {
      return selectedGroups.every((group) => groups.has(group));
    }
    return selectedGroups.some((group) => groups.has(group));
  });
}
