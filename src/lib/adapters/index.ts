import type { ServerConfig, ServerAdapter } from "../types";
import { NewApiAdapter } from "./newapi";
import { RixApiAdapter } from "./rixapi";

const newApiAdapter = new NewApiAdapter();
const rixApiAdapter = new RixApiAdapter();

export function getAdapter(config: ServerConfig): ServerAdapter {
  switch (config.type) {
    case "newapi":
      return newApiAdapter;
    case "rixapi":
      return rixApiAdapter;
    default:
      throw new Error(`Unknown server type: ${config.type}`);
  }
}
