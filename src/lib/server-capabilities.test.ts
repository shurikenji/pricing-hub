import { describe, expect, it } from "vitest";

import {
  getServerCapability,
  matchModelsByGroups,
  normalizeSelectedGroups,
  validateServerConfigCapabilities,
} from "./server-capabilities";
import type { NormalizedModel, ServerConfig } from "./types";

const baseServer: ServerConfig = {
  id: "server-1",
  name: "Server 1",
  baseUrl: "https://example.com",
  type: "newapi",
  supportsGroupChain: false,
  enabled: true,
  ratioConfigEnabled: false,
  authMode: "header",
  authUserHeader: "X-User",
  authUserValue: "1",
  authToken: "secret",
  authCookie: "",
  pricingPath: "/api/pricing",
  ratioConfigPath: "/api/ratio",
  logPath: "/api/logs",
  tokenSearchPath: "/api/token/search",
  tokenUpdatePath: "/api/token",
  groupsPath: "/api/groups",
  notes: "",
};

const models: NormalizedModel[] = [
  {
    modelName: "single-a",
    quotaType: 0,
    pricingMode: "token",
    modelRatio: 1,
    completionRatio: 1,
    modelPrice: 0,
    enableGroups: ["a"],
    supportedEndpoints: ["chat"],
    endpointDetails: [{ type: "chat" }],
  },
  {
    modelName: "multi-ab",
    quotaType: 0,
    pricingMode: "token",
    modelRatio: 1,
    completionRatio: 1,
    modelPrice: 0,
    enableGroups: ["a", "b"],
    supportedEndpoints: ["chat"],
    endpointDetails: [{ type: "chat" }],
  },
];

describe("server capabilities", () => {
  it("derives sensible defaults from server type", () => {
    expect(getServerCapability(baseServer)).toMatchObject({
      groupSelectionMode: "single",
      groupMatchMode: "union",
      tokenUpdateMode: "newapi_put",
    });

    expect(
      getServerCapability({
        ...baseServer,
        type: "rixapi",
        supportsGroupChain: true,
      }),
    ).toMatchObject({
      groupSelectionMode: "chain",
      tokenUpdateMode: "rixapi_put",
    });
  });

  it("enforces single-group normalization and supports multi-group modes", () => {
    expect(normalizeSelectedGroups(["a", "a", "b"], "single")).toEqual(["a"]);
    expect(normalizeSelectedGroups(["a", "a", "b"], "chain")).toEqual(["a", "b"]);
  });

  it("matches models by union or intersection according to capability", () => {
    expect(matchModelsByGroups(models, ["a", "b"], "union").map((model) => model.modelName)).toEqual(["single-a", "multi-ab"]);
    expect(matchModelsByGroups(models, ["a", "b"], "intersection").map((model) => model.modelName)).toEqual(["multi-ab"]);
  });

  it("rejects contradictory capability configuration", () => {
    const errors = validateServerConfigCapabilities({
      ...baseServer,
      groupSelectionMode: "single",
      supportsGroupChain: true,
    });

    expect(errors).toContain("supportsGroupChain cannot be enabled when groupSelectionMode is single.");
  });
});
