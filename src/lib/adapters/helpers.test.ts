import { describe, expect, it } from "vitest";

import { estimateLogUsd, inferPricingMode } from "./helpers";

describe("pricing helper formulas", () => {
  it("treats quota_type=1 as request_scaled regardless of model ratios", () => {
    expect(inferPricingMode(1, 0.25, 99, 3)).toBe("request_scaled");
  });

  it("calculates request_scaled log cost from group ratio and model price", () => {
    expect(
      estimateLogUsd({
        quotaType: 1,
        groupRatio: 2,
        modelRatio: 5,
        completionRatio: 4,
        promptTokens: 1000,
        completionTokens: 1000,
        modelPrice: 0.5,
      }),
    ).toBe(1);
  });

  it("keeps token and fixed pricing modes separate when quota_type is 0", () => {
    expect(inferPricingMode(0, 0, 2, 1.5)).toBe("token");
    expect(inferPricingMode(0, 0.4, 0, 0)).toBe("fixed");
  });
});
