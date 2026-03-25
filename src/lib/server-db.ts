import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AdminAuditLog, NormalizedPricing, PricingSnapshotSummary, ServerConfig } from "./types";

const STORE_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(STORE_DIR, "servers.local.json");
const DB_FILE = path.join(STORE_DIR, "pricing-hub.sqlite");

const defaultServers: ServerConfig[] = [
  {
    id: "aabao",
    name: "AABao (NewAPI)",
    baseUrl: "https://api.aabao.top",
    type: "newapi",
    supportsGroupChain: false,
    ratioConfigEnabled: true,
    enabled: true,
    authMode: "header",
    authUserHeader: "New-Api-User",
    authUserValue: process.env.AABAO_USER_ID ?? "",
    authToken: process.env.AABAO_ACCESS_TOKEN ?? "",
    pricingPath: "/api/pricing",
    ratioConfigPath: "/api/ratio_config",
    logPath: "/api/log/self",
    tokenSearchPath: "/api/token/search",
    groupsPath: "/api/user/self/groups",
    notes: "Public pricing may need ratio_config to become complete.",
  },
  {
    id: "996444",
    name: "996444 (RixAPI)",
    baseUrl: "https://api.996444.cn",
    type: "rixapi",
    supportsGroupChain: true,
    ratioConfigEnabled: false,
    enabled: true,
    authMode: "header",
    authUserHeader: process.env.RIX_USER_HEADER ?? "New-Api-User",
    authUserValue: process.env.RIX_USER_ID ?? "",
    authToken: process.env.RIX_ACCESS_TOKEN ?? "",
    pricingPath: "/api/pricing",
    logPath: "/api/log/self",
    tokenSearchPath: "/api/token/search",
    groupsPath: "/api/token/group",
    notes: "Group ratios are exposed inline via pricing payload.",
  },
];

let database: DatabaseSync | null = null;

function ensureStoreDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function openDatabase() {
  ensureStoreDir();
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pricing_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      model_count INTEGER NOT NULL,
      group_count INTEGER NOT NULL,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);
  return db;
}

function parseServersFromFile(): ServerConfig[] {
  if (!fs.existsSync(STORE_FILE)) {
    return defaultServers;
  }

  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as ServerConfig[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : defaultServers;
  } catch {
    return defaultServers;
  }
}

function seedServersIfEmpty(db: DatabaseSync) {
  const count = db.prepare("SELECT COUNT(*) as count FROM servers").get() as { count: number };
  if (count.count > 0) {
    return;
  }

  const seedServers = parseServersFromFile();
  const insert = db.prepare(`
    INSERT INTO servers (id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const now = Date.now();

  for (const server of seedServers) {
    insert.run(server.id, JSON.stringify(server), now, now);
  }
}

function getDb() {
  if (!database) {
    database = openDatabase();
    seedServersIfEmpty(database);
  }
  return database;
}

function parseServerRow(row: { payload: string }): ServerConfig {
  return JSON.parse(row.payload) as ServerConfig;
}

export function listServers(): ServerConfig[] {
  const rows = getDb()
    .prepare("SELECT payload FROM servers ORDER BY id ASC")
    .all() as Array<{ payload: string }>;

  return rows.map(parseServerRow);
}

export function getServerById(id: string): ServerConfig | undefined {
  const row = getDb()
    .prepare("SELECT payload FROM servers WHERE id = ?")
    .get(id) as { payload: string } | undefined;

  return row ? parseServerRow(row) : undefined;
}

export function insertServer(config: ServerConfig) {
  const now = Date.now();
  getDb()
    .prepare(`
      INSERT INTO servers (id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(config.id, JSON.stringify(config), now, now);
}

export function patchServer(id: string, partial: Partial<ServerConfig>): boolean {
  const current = getServerById(id);
  if (!current) {
    return false;
  }

  const next = { ...current, ...partial };
  getDb()
    .prepare("UPDATE servers SET payload = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(next), Date.now(), id);
  return true;
}

export function deleteServerById(id: string): boolean {
  const result = getDb().prepare("DELETE FROM servers WHERE id = ?").run(id);
  return Number(result.changes || 0) > 0;
}

export function appendAuditLog(entry: Omit<AdminAuditLog, "id" | "createdAt">) {
  getDb()
    .prepare(`
      INSERT INTO admin_audit_logs (action, target_type, target_id, detail, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(entry.action, entry.targetType, entry.targetId ?? null, entry.detail ?? null, Date.now());
}

export function listAuditLogs(limit = 25): AdminAuditLog[] {
  const rows = getDb()
    .prepare(`
      SELECT id, action, target_type, target_id, detail, created_at
      FROM admin_audit_logs
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      id: number;
      action: string;
      target_type: string;
      target_id?: string;
      detail?: string;
      created_at: number;
    }>;

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}

export function insertPricingSnapshot(serverId: string, pricing: NormalizedPricing) {
  const payload = JSON.stringify(pricing);
  const fetchedAt = pricing.fetchedAt || Date.now();
  const result = getDb()
    .prepare(`
      INSERT INTO pricing_snapshots (server_id, server_name, model_count, group_count, payload, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(
      serverId,
      pricing.serverName,
      pricing.models.length,
      pricing.groups.length,
      payload,
      fetchedAt,
    );

  return Number(result.lastInsertRowid);
}

export function listPricingSnapshots(limit = 25, serverId?: string): PricingSnapshotSummary[] {
  const statement = serverId
    ? getDb().prepare(`
        SELECT id, server_id, server_name, model_count, group_count, fetched_at
        FROM pricing_snapshots
        WHERE server_id = ?
        ORDER BY fetched_at DESC
        LIMIT ?
      `)
    : getDb().prepare(`
        SELECT id, server_id, server_name, model_count, group_count, fetched_at
        FROM pricing_snapshots
        ORDER BY fetched_at DESC
        LIMIT ?
      `);

  const rows = (serverId ? statement.all(serverId, limit) : statement.all(limit)) as Array<{
    id: number;
    server_id: string;
    server_name: string;
    model_count: number;
    group_count: number;
    fetched_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    modelCount: row.model_count,
    groupCount: row.group_count,
    fetchedAt: row.fetched_at,
  }));
}
