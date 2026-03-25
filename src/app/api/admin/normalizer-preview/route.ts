import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isAdminRequest } from "@/lib/admin-auth";
import {
  normalizeCustomLogPayload,
  normalizeCustomPricingPayload,
  normalizeCustomTokenPayload,
  parseCustomNormalizerHints,
} from "@/lib/custom-normalizer";
import { appendAuditLog } from "@/lib/server-db";
import { getServer } from "@/lib/servers";
import type { NormalizerPreviewDiagnostics, PricingMode, ServerConfig } from "@/lib/types";

const MAX_JSON_BYTES = 256_000;
const PREVIEW_MODEL_LIMIT = 12;
const PREVIEW_LOG_LIMIT = 12;

interface PreviewRequestBody {
  serverId?: string;
  hintsJson?: string;
  pricingPayload?: string;
  logsPayload?: string;
  tokenPayload?: string;
  apiKey?: string;
}

function getActor(request: Request) {
  return request.headers.get("x-forwarded-for") || "admin-session";
}

function parseJsonInput(raw: string | undefined, label: string) {
  if (!raw?.trim()) {
    return { provided: false as const };
  }

  if (Buffer.byteLength(raw, "utf8") > MAX_JSON_BYTES) {
    return {
      provided: true as const,
      error: `${label} exceeds the preview size limit of ${MAX_JSON_BYTES} bytes.`,
    };
  }

  try {
    return {
      provided: true as const,
      value: JSON.parse(raw) as unknown,
    };
  } catch {
    return {
      provided: true as const,
      error: `${label} must be valid JSON.`,
    };
  }
}

function buildPreviewConfig(source: ServerConfig | undefined, hintsJson?: string): ServerConfig {
  const config: ServerConfig = source
    ? { ...source }
    : {
        id: "preview",
        name: "Preview Workspace",
        baseUrl: "http://localhost",
        type: "custom",
        supportsGroupChain: false,
        ratioConfigEnabled: false,
        enabled: false,
        authMode: "none",
      };

  if (hintsJson !== undefined) {
    config.normalizerHintJson = hintsJson;
  }

  return config;
}

function countModes(values: Array<PricingMode | undefined>) {
  return values.reduce<Partial<Record<PricingMode, number>>>((accumulator, mode) => {
    if (!mode) {
      return accumulator;
    }
    accumulator[mode] = (accumulator[mode] || 0) + 1;
    return accumulator;
  }, {});
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const requestId = randomUUID();
  const body = (await request.json().catch(() => null)) as PreviewRequestBody | null;
  if (!body) {
    return apiError("INVALID_PREVIEW_REQUEST", "Invalid preview request", 400, undefined, requestId);
  }

  const pricingInput = parseJsonInput(body.pricingPayload, "Pricing payload");
  const logsInput = parseJsonInput(body.logsPayload, "Logs payload");
  const tokenInput = parseJsonInput(body.tokenPayload, "Token payload");
  if (!pricingInput.provided && !logsInput.provided && !tokenInput.provided) {
    return apiError("PREVIEW_EMPTY", "Provide at least one JSON payload to preview.", 400, undefined, requestId);
  }

  try {
    parseCustomNormalizerHints(body.hintsJson ?? null);
  } catch {
    return apiError("INVALID_HINTS", "Normalizer hints must be valid JSON.", 400, undefined, requestId);
  }

  const config = buildPreviewConfig(body.serverId ? getServer(body.serverId) : undefined, body.hintsJson);
  const warnings: string[] = [];
  const unresolvedWarnings: string[] = [];
  const sections: Record<string, unknown> = {};
  const diagnostics: NormalizerPreviewDiagnostics = {
    sourceServerId: body.serverId,
    pricingModelCount: 0,
    pricingGroupCount: 0,
    logRowCount: 0,
    trimmedModelCount: 0,
    trimmedLogCount: 0,
    detectedModes: {},
    unresolvedWarnings,
  };

  if (pricingInput.provided) {
    if ("error" in pricingInput) {
      sections.pricingError = pricingInput.error;
    } else {
      try {
        const pricing = normalizeCustomPricingPayload(pricingInput.value, config);
        diagnostics.pricingModelCount = pricing.models.length;
        diagnostics.pricingGroupCount = pricing.groups.length;
        diagnostics.detectedModes = countModes(pricing.models.map((model) => model.pricingMode));
        sections.pricing = {
          modelCount: pricing.models.length,
          groupCount: pricing.groups.length,
          groups: pricing.groups.slice(0, PREVIEW_MODEL_LIMIT),
          models: pricing.models.slice(0, PREVIEW_MODEL_LIMIT),
        };
        if (pricing.groups.length === 0) {
          unresolvedWarnings.push("No groups were resolved from the pricing payload.");
        }
        if (pricing.models.length === 0) {
          unresolvedWarnings.push("No models were resolved from the pricing payload.");
        }
        if (pricing.models.length > PREVIEW_MODEL_LIMIT) {
          diagnostics.trimmedModelCount = pricing.models.length - PREVIEW_MODEL_LIMIT;
          warnings.push(`Pricing preview trimmed to the first ${PREVIEW_MODEL_LIMIT} models out of ${pricing.models.length}.`);
        }
      } catch {
        sections.pricingError = "Failed to normalize pricing payload with the current hints.";
      }
    }
  }

  if (logsInput.provided) {
    if ("error" in logsInput) {
      sections.logsError = logsInput.error;
    } else {
      try {
        const logs = normalizeCustomLogPayload(logsInput.value, { page: 1, pageSize: 20 }, config);
        diagnostics.logRowCount = logs.total;
        sections.logs = {
          total: logs.total,
          items: logs.items.slice(0, PREVIEW_LOG_LIMIT),
        };
        if (logs.items.length === 0) {
          unresolvedWarnings.push("No log entries were resolved from the logs payload.");
        }
        if (logs.items.length > PREVIEW_LOG_LIMIT) {
          diagnostics.trimmedLogCount = logs.items.length - PREVIEW_LOG_LIMIT;
          warnings.push(`Log preview trimmed to the first ${PREVIEW_LOG_LIMIT} rows out of ${logs.items.length}.`);
        }
        const logModes = countModes(logs.items.map((item) => item.pricingMode));
        diagnostics.detectedModes = {
          ...diagnostics.detectedModes,
          ...Object.fromEntries(
            Object.entries(logModes).map(([key, value]) => [
              key,
              (diagnostics.detectedModes[key as PricingMode] || 0) + (value || 0),
            ]),
          ),
        };
      } catch {
        sections.logsError = "Failed to normalize logs payload with the current hints.";
      }
    }
  }

  if (tokenInput.provided) {
    if ("error" in tokenInput) {
      sections.tokenError = tokenInput.error;
    } else {
      try {
        sections.token = normalizeCustomTokenPayload(tokenInput.value, body.apiKey || "sk-preview", config);
        if (!sections.token) {
          warnings.push("Token payload parsed, but no matching token was found for the supplied API key.");
          unresolvedWarnings.push("Token payload did not contain a token matching the provided API key hint.");
        }
      } catch {
        sections.tokenError = "Failed to normalize token payload with the current hints.";
      }
    }
  }

  appendAuditLog({
    action: "normalizer.previewed",
    targetType: "server",
    targetId: body.serverId || "preview",
    detail: JSON.stringify({
      actor: getActor(request),
      requestId,
      sections: {
        pricing: pricingInput.provided,
        logs: logsInput.provided,
        token: tokenInput.provided,
      },
      warnings: warnings.length,
      diagnostics,
    }),
  });

  return NextResponse.json({
    success: true,
    requestId,
    warnings,
    diagnostics,
    ...sections,
  });
}
