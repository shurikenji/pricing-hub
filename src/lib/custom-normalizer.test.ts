import { describe, expect, it } from "vitest";

import {
  normalizeCustomLogPayload,
  normalizeCustomPricingPayload,
  normalizeCustomTokenPayload,
} from "./custom-normalizer";

describe("custom normalizer", () => {
  it("normalizes newapi-style pricing and keeps quota_type=1 as request_scaled", () => {
    const pricing = normalizeCustomPricingPayload(
      {
        data: [
          {
            model_name: "gpt-4o-mini",
            quota_type: 1,
            model_ratio: 2.5,
            completion_ratio: 3,
            model_price: 0.12,
            enable_groups: ["default"],
            supported_endpoint_types: ["chat"],
          },
        ],
      },
      {
        name: "NewAPI Preview",
        normalizerHintJson: JSON.stringify({
          pricingDataPath: "data",
          groupDataPath: "data.groups",
          requestScaledQuotaType: 1,
        }),
      },
    );

    expect(pricing.groups.map((group) => group.name)).toEqual(["default"]);
    expect(pricing.models[0]?.pricingMode).toBe("request_scaled");
    expect(pricing.models[0]?.requestPrice).toBe(0.12);
    expect(pricing.models[0]?.inputPricePer1M).toBeUndefined();
  });

  it("normalizes rixapi-style inline group ratios into per-group token prices", () => {
    const pricing = normalizeCustomPricingPayload(
      {
        data: {
          group_info: [
            { Group: "default", GroupRatio: 1.5 },
            { Group: "vip", GroupRatio: 2 },
          ],
          model_info: [
            {
              ModelName: "claude-3-5-sonnet",
              QuotaType: 0,
              ModelRatio: 3,
              CompletionRatio: 2,
              ModelPrice: 0,
              enable_groups: ["default", "vip"],
              supported_endpoint_types: ["chat", "responses"],
            },
          ],
        },
      },
      {
        name: "Rix Preview",
        normalizerHintJson: JSON.stringify({
          pricingDataPath: "data.model_info",
          groupInfoPath: "data.group_info",
          modelNameField: "ModelName",
          quotaTypeField: "QuotaType",
          modelRatioField: "ModelRatio",
          completionRatioField: "CompletionRatio",
          modelPriceField: "ModelPrice",
          enableGroupsField: "enable_groups",
          supportedEndpointsField: "supported_endpoint_types",
          groupNameField: "Group",
          groupDisplayNameField: "Group",
          groupRatioField: "GroupRatio",
        }),
      },
    );

    const model = pricing.models[0];
    expect(pricing.groups).toHaveLength(2);
    expect(model?.pricingMode).toBe("token");
    expect(model?.groupPrices?.default?.inputPricePer1M).toBe(9);
    expect(model?.groupPrices?.default?.outputPricePer1M).toBe(18);
    expect(model?.groupPrices?.vip?.inputPricePer1M).toBe(12);
    expect(model?.groupPrices?.vip?.outputPricePer1M).toBe(24);
  });

  it("normalizes mixed custom payloads for pricing, logs, and token lookup", () => {
    const config = {
      normalizerHintJson: JSON.stringify({
        pricingDataPath: "payload.pricing.rows",
        groupInfoPath: "payload.groups",
        modelNameField: "meta.name",
        quotaTypeField: "meta.quota.kind",
        modelRatioField: "meta.ratios.model",
        completionRatioField: "meta.ratios.completion",
        modelPriceField: "meta.requestPrice",
        enableGroupsField: "meta.groups",
        supportedEndpointsField: "meta.endpoints",
        groupNameField: "code",
        groupDisplayNameField: "label",
        groupRatioField: "ratio",
        logItemsPath: "payload.logs.records",
        tokenItemsPath: "payload.tokens.rows",
        requestScaledQuotaType: 9,
      }),
    } as const;

    const pricing = normalizeCustomPricingPayload(
      {
        payload: {
          groups: [
            { code: "pro", label: "Pro", ratio: 1.4 },
            { code: "req", label: "Request", ratio: 2 },
          ],
          pricing: {
            rows: [
              {
                meta: {
                  name: "mixed-model",
                  quota: { kind: 9 },
                  ratios: { model: 4, completion: 1.5 },
                  requestPrice: 0.3,
                  groups: ["pro", "req"],
                  endpoints: ["chat"],
                },
              },
            ],
          },
          logs: {
            records: [
              {
                id: 12,
                created_at: 1700000000,
                token_name: "alpha",
                token_group: "req",
                model_name: "mixed-model",
                quota: 300000,
                prompt_tokens: 1200,
                completion_tokens: 200,
                use_time: 123,
                is_stream: false,
                other: JSON.stringify({
                  quota_type: 9,
                  group_ratio: 2,
                  model_ratio: 4,
                  completion_ratio: 1.5,
                  model_price: 0.3,
                }),
              },
            ],
          },
          tokens: {
            rows: [{ id: 7, name: "alpha", key: "sk-demo-key", remain_quota: 88 }],
          },
        },
      },
      { name: "Mixed Preview", normalizerHintJson: config.normalizerHintJson },
    );

    const logs = normalizeCustomLogPayload(
      {
        payload: {
          logs: {
            records: [
              {
                id: 12,
                created_at: 1700000000,
                token_name: "alpha",
                token_group: "req",
                model_name: "mixed-model",
                quota: 300000,
                prompt_tokens: 1200,
                completion_tokens: 200,
                use_time: 123,
                is_stream: false,
                other: JSON.stringify({
                  quota_type: 9,
                  group_ratio: 2,
                  model_ratio: 4,
                  completion_ratio: 1.5,
                  model_price: 0.3,
                }),
              },
            ],
          },
        },
      },
      {},
      config,
    );

    const token = normalizeCustomTokenPayload(
      {
        payload: {
          tokens: {
            rows: [{ id: 7, name: "alpha", key: "sk-demo-key", remain_quota: 88 }],
          },
        },
      },
      "demo-key",
      config,
    );

    expect(pricing.models[0]?.pricingMode).toBe("request_scaled");
    expect(pricing.models[0]?.groupPrices?.req?.requestPrice).toBe(0.6);
    expect(logs.items[0]?.pricingMode).toBe("request_scaled");
    expect(logs.items[0]?.estimatedUsd).toBe(0.6);
    expect(token?.name).toBe("alpha");
  });
});
