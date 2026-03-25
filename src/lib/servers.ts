import type { ServerConfig } from "./types";
import {
  deleteServerById,
  getServerById,
  insertServer,
  listServers,
  patchServer,
} from "./server-db";

export function getServers(): ServerConfig[] {
  return listServers().filter((server) => server.enabled);
}

export function getAllServers(): ServerConfig[] {
  return listServers();
}

export function getServer(id: string): ServerConfig | undefined {
  return getServerById(id);
}

export function addServer(config: ServerConfig): void {
  insertServer(config);
}

export function updateServer(id: string, partial: Partial<ServerConfig>): boolean {
  return patchServer(id, partial);
}

export function removeServer(id: string): boolean {
  return deleteServerById(id);
}
