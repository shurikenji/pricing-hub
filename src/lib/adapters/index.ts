import type { ServerConfig, ServerAdapter } from "../types";
import { CustomAdapter } from "./custom";
import { NewApiAdapter } from "./newapi";
import { RixApiAdapter } from "./rixapi";

const newApiAdapter = new NewApiAdapter();
const rixApiAdapter = new RixApiAdapter();
const customAdapter = new CustomAdapter();

export function getAdapter(config: ServerConfig): ServerAdapter {
  switch (config.type) {
    case "newapi":
      return newApiAdapter;
    case "rixapi":
      return rixApiAdapter;
    case "custom":
      return customAdapter;
    default:
      throw new Error(`Unknown server type: ${config.type}`);
  }
}
