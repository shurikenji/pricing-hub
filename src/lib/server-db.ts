import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AdminAuditLog,
  NormalizedModel,
  NormalizedPricing,
  PricingSnapshotDiff,
  PricingSnapshotDiffItem,
  PricingSnapshotRecord,
  PricingSnapshotSummary,
  ServerConfig,
  ServerHealthHistoryEntry,
  ServerHealthResult,
  ServerSamplePayload,
} from "./types";
import { decryptServerSecrets, encryptServerSecrets, hasPlaintextServerSecrets } from "./secure-config";
import { getServerCapability } from "./server-capabilities";

const STORE_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(STORE_DIR, "servers.local.json");
const DB_FILE = path.join(STORE_DIR, "pricing-hub.sqlite");
const AUDIT_LOG_RETENTION = 500;
const SNAPSHOT_RETENTION_PER_SERVER = 30;
const HEALTH_HISTORY_RETENTION_PER_SERVER = 40;

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
    autoSyncEnabled: true,
    autoSyncIntervalMinutes: 180,
    lastPricingSyncStatus: "idle",
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
    autoSyncEnabled: true,
    autoSyncIntervalMinutes: 180,
    lastPricingSyncStatus: "idle",
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

    CREATE TABLE IF NOT EXISTS server_samples (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      sample_type TEXT NOT NULL,
      label TEXT NOT NULL,
      notes TEXT,
      payload_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS server_health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      status TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      http_status INTEGER,
      message TEXT NOT NULL
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

function migratePlaintextServerSecrets(db: DatabaseSync) {
  const rows = db.prepare("SELECT id, payload FROM servers").all() as Array<{ id: string; payload: string }>;
  const update = db.prepare("UPDATE servers SET payload = ?, updated_at = ? WHERE id = ?");

  for (const row of rows) {
    const parsed = JSON.parse(row.payload) as ServerConfig;
    if (!hasPlaintextServerSecrets(parsed)) {
      continue;
    }

    update.run(JSON.stringify(encryptServerSecrets(withServerDefaults(parsed))), Date.now(), row.id);
  }
}

function getDb() {
  if (!database) {
    database = openDatabase();
    seedServersIfEmpty(database);
    migratePlaintextServerSecrets(database);
  }
  return database;
}

function withServerDefaults(server: ServerConfig): ServerConfig {
  const capability = getServerCapability(server);
  const next = {
    ...server,
    supportsGroupChain: capability.groupSelectionMode !== "single",
    groupSelectionMode: capability.groupSelectionMode,
    groupMatchMode: capability.groupMatchMode,
    tokenUpdateMode: capability.tokenUpdateMode,
    tokenSearchMode: capability.tokenSearchMode,
    logResolveMode: capability.logResolveMode,
    autoSyncEnabled: server.autoSyncEnabled ?? false,
    autoSyncIntervalMinutes: server.autoSyncIntervalMinutes ?? 180,
    lastPricingSyncStatus: server.lastPricingSyncStatus ?? "idle",
    lastHealthStatus: server.lastHealthStatus ?? "unknown",
    lastSyncModelCount: server.lastSyncModelCount ?? 0,
    lastSyncGroupCount: server.lastSyncGroupCount ?? 0,
    tokenUpdatePath: server.tokenUpdatePath || "/api/token/",
  };

  if (!next.autoSyncEnabled) {
    next.nextPricingSyncAt = undefined;
  }

  return next;
}

function parseServerRow(row: { payload: string }): ServerConfig {
  return withServerDefaults(decryptServerSecrets(JSON.parse(row.payload) as ServerConfig));
}

function cleanupAuditLogRetention() {
  getDb().prepare(`
    DELETE FROM admin_audit_logs
    WHERE id NOT IN (
      SELECT id
      FROM admin_audit_logs
      ORDER BY created_at DESC
      LIMIT ?
    )
  `).run(AUDIT_LOG_RETENTION);
}

function cleanupSnapshotRetention(serverId: string) {
  getDb().prepare(`
    DELETE FROM pricing_snapshots
    WHERE server_id = ?
      AND id NOT IN (
        SELECT id
        FROM pricing_snapshots
        WHERE server_id = ?
        ORDER BY fetched_at DESC
        LIMIT ?
      )
  `).run(serverId, serverId, SNAPSHOT_RETENTION_PER_SERVER);
}

function cleanupHealthHistoryRetention(serverId: string) {
  getDb().prepare(`
    DELETE FROM server_health_checks
    WHERE server_id = ?
      AND id NOT IN (
        SELECT id
        FROM server_health_checks
        WHERE server_id = ?
        ORDER BY checked_at DESC
        LIMIT ?
      )
  `).run(serverId, serverId, HEALTH_HISTORY_RETENTION_PER_SERVER);
}

function getComparablePrices(model: NormalizedModel) {
  const snapshots = Object.values(model.groupPrices || {});
  const inputs = snapshots
    .map((snapshot) => snapshot.inputPricePer1M)
    .filter((value): value is number => typeof value === "number");
  const outputs = snapshots
    .map((snapshot) => snapshot.outputPricePer1M)
    .filter((value): value is number => typeof value === "number");
  const requests = snapshots
    .map((snapshot) => snapshot.requestPrice)
    .filter((value): value is number => typeof value === "number");

  return {
    input: inputs.length > 0 ? Math.min(...inputs) : model.inputPricePer1M,
    output: outputs.length > 0 ? Math.min(...outputs) : model.outputPricePer1M,
    request: requests.length > 0 ? Math.min(...requests) : model.requestPrice,
  };
}

function getModelChange(left?: NormalizedModel, right?: NormalizedModel): PricingSnapshotDiffItem | null {
  if (!left && !right) {
    return null;
  }

  const modelName = right?.modelName || left?.modelName || "unknown";
  if (!left && right) {
    const prices = getComparablePrices(right);
    return {
      modelName,
      changeType: "added",
      pricingModeAfter: right.pricingMode,
      inputAfter: prices.input,
      outputAfter: prices.output,
      requestAfter: prices.request,
      groupsBefore: [],
      groupsAfter: right.enableGroups,
    };
  }

  if (left && !right) {
    const prices = getComparablePrices(left);
    return {
      modelName,
      changeType: "removed",
      pricingModeBefore: left.pricingMode,
      inputBefore: prices.input,
      outputBefore: prices.output,
      requestBefore: prices.request,
      groupsBefore: left.enableGroups,
      groupsAfter: [],
    };
  }

  const beforePrices = getComparablePrices(left!);
  const afterPrices = getComparablePrices(right!);
  const groupsBefore = [...left!.enableGroups].sort();
  const groupsAfter = [...right!.enableGroups].sort();
  const changed =
    left!.pricingMode !== right!.pricingMode ||
    beforePrices.input !== afterPrices.input ||
    beforePrices.output !== afterPrices.output ||
    beforePrices.request !== afterPrices.request ||
    groupsBefore.join("|") !== groupsAfter.join("|");

  if (!changed) {
    return null;
  }

  return {
    modelName,
    changeType: "updated",
    pricingModeBefore: left!.pricingMode,
    pricingModeAfter: right!.pricingMode,
    inputBefore: beforePrices.input,
    inputAfter: afterPrices.input,
    outputBefore: beforePrices.output,
    outputAfter: afterPrices.output,
    requestBefore: beforePrices.request,
    requestAfter: afterPrices.request,
    groupsBefore,
    groupsAfter,
  };
}

function sortDiffItems(items: PricingSnapshotDiffItem[]) {
  return [...items].sort((left, right) => {
    const leftMagnitude = Math.max(
      Math.abs((left.inputAfter ?? left.inputBefore ?? 0) - (left.inputBefore ?? left.inputAfter ?? 0)),
      Math.abs((left.outputAfter ?? left.outputBefore ?? 0) - (left.outputBefore ?? left.outputAfter ?? 0)),
      Math.abs((left.requestAfter ?? left.requestBefore ?? 0) - (left.requestBefore ?? left.requestAfter ?? 0)),
    );
    const rightMagnitude = Math.max(
      Math.abs((right.inputAfter ?? right.inputBefore ?? 0) - (right.inputBefore ?? right.inputAfter ?? 0)),
      Math.abs((right.outputAfter ?? right.outputBefore ?? 0) - (right.outputBefore ?? right.outputAfter ?? 0)),
      Math.abs((right.requestAfter ?? right.requestBefore ?? 0) - (right.requestBefore ?? right.requestAfter ?? 0)),
    );
    return rightMagnitude - leftMagnitude || left.modelName.localeCompare(right.modelName);
  });
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
  const next = withServerDefaults(config);
  getDb()
    .prepare(`
      INSERT INTO servers (id, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(next.id, JSON.stringify(encryptServerSecrets(next)), now, now);
}

export function patchServer(id: string, partial: Partial<ServerConfig>): boolean {
  const current = getServerById(id);
  if (!current) {
    return false;
  }

  const next = withServerDefaults({ ...current, ...partial });
  getDb()
    .prepare("UPDATE servers SET payload = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(encryptServerSecrets(next)), Date.now(), id);
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
  cleanupAuditLogRetention();
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

  cleanupSnapshotRetention(serverId);
  return Number(result.lastInsertRowid);
}

export function getPricingSnapshotRecord(snapshotId: number): PricingSnapshotRecord | null {
  const row = getDb()
    .prepare(`
      SELECT id, server_id, server_name, model_count, group_count, payload, fetched_at
      FROM pricing_snapshots
      WHERE id = ?
      LIMIT 1
    `)
    .get(snapshotId) as
    | {
        id: number;
        server_id: string;
        server_name: string;
        model_count: number;
        group_count: number;
        payload: string;
        fetched_at: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    modelCount: row.model_count,
    groupCount: row.group_count,
    fetchedAt: row.fetched_at,
    pricing: JSON.parse(row.payload) as NormalizedPricing,
  };
}

export function getLatestPricingSnapshot(serverId: string): { id: number; pricing: NormalizedPricing; fetchedAt: number } | null {
  const row = getDb()
    .prepare(`
      SELECT id, payload, fetched_at
      FROM pricing_snapshots
      WHERE server_id = ?
      ORDER BY fetched_at DESC
      LIMIT 1
    `)
    .get(serverId) as
    | {
        id: number;
        payload: string;
        fetched_at: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    pricing: JSON.parse(row.payload) as NormalizedPricing,
    fetchedAt: row.fetched_at,
  };
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

export function listPricingSnapshotRecords(serverId: string, limit = 12): PricingSnapshotRecord[] {
  const rows = getDb()
    .prepare(`
      SELECT id, server_id, server_name, model_count, group_count, payload, fetched_at
      FROM pricing_snapshots
      WHERE server_id = ?
      ORDER BY fetched_at DESC
      LIMIT ?
    `)
    .all(serverId, limit) as Array<{
      id: number;
      server_id: string;
      server_name: string;
      model_count: number;
      group_count: number;
      payload: string;
      fetched_at: number;
    }>;

  return rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    modelCount: row.model_count,
    groupCount: row.group_count,
    fetchedAt: row.fetched_at,
    pricing: JSON.parse(row.payload) as NormalizedPricing,
  }));
}

export function comparePricingSnapshots(serverId: string, baseSnapshotId?: number, compareSnapshotId?: number): PricingSnapshotDiff | null {
  const rows = getDb()
    .prepare(`
      SELECT id, server_id, server_name, payload, fetched_at
      FROM pricing_snapshots
      WHERE server_id = ?
      ORDER BY fetched_at DESC
      LIMIT 20
    `)
    .all(serverId) as Array<{
      id: number;
      server_id: string;
      server_name: string;
      payload: string;
      fetched_at: number;
    }>;

  if (rows.length < 2) {
    return null;
  }

  const compareRow = compareSnapshotId ? rows.find((row) => row.id === compareSnapshotId) : rows[0];
  const baseRow = baseSnapshotId ? rows.find((row) => row.id === baseSnapshotId) : rows.find((row) => row.id !== compareRow?.id);
  if (!compareRow || !baseRow) {
    return null;
  }

  const left = JSON.parse(baseRow.payload) as NormalizedPricing;
  const right = JSON.parse(compareRow.payload) as NormalizedPricing;
  const leftModels = new Map(left.models.map((model) => [model.modelName, model]));
  const rightModels = new Map(right.models.map((model) => [model.modelName, model]));
  const modelNames = Array.from(new Set([...leftModels.keys(), ...rightModels.keys()]));

  const items = modelNames
    .map((modelName) => getModelChange(leftModels.get(modelName), rightModels.get(modelName)))
    .filter((item): item is PricingSnapshotDiffItem => Boolean(item));

  const addedCount = items.filter((item) => item.changeType === "added").length;
  const removedCount = items.filter((item) => item.changeType === "removed").length;
  const updatedCount = items.filter((item) => item.changeType === "updated").length;

  return {
    serverId,
    serverName: compareRow.server_name,
    baseSnapshotId: baseRow.id,
    compareSnapshotId: compareRow.id,
    baseFetchedAt: baseRow.fetched_at,
    compareFetchedAt: compareRow.fetched_at,
    addedCount,
    removedCount,
    updatedCount,
    unchangedCount: Math.max(modelNames.length - items.length, 0),
    items: sortDiffItems(items).slice(0, 40),
  };
}

export function upsertServerSample(sample: ServerSamplePayload) {
  getDb()
    .prepare(`
      INSERT INTO server_samples (id, server_id, sample_type, label, notes, payload_json, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        server_id = excluded.server_id,
        sample_type = excluded.sample_type,
        label = excluded.label,
        notes = excluded.notes,
        payload_json = excluded.payload_json,
        version = excluded.version,
        updated_at = excluded.updated_at
    `)
    .run(
      sample.id,
      sample.serverId,
      sample.sampleType,
      sample.label,
      sample.notes ?? null,
      sample.payloadJson,
      sample.version,
      sample.createdAt,
      sample.updatedAt,
    );
}

export function listServerSamples(serverId?: string, sampleType?: ServerSamplePayload["sampleType"]): ServerSamplePayload[] {
  const rows = serverId
    ? sampleType
      ? getDb()
          .prepare(`
            SELECT id, server_id, sample_type, label, notes, payload_json, version, created_at, updated_at
            FROM server_samples
            WHERE server_id = ? AND sample_type = ?
            ORDER BY updated_at DESC
          `)
          .all(serverId, sampleType)
      : getDb()
          .prepare(`
            SELECT id, server_id, sample_type, label, notes, payload_json, version, created_at, updated_at
            FROM server_samples
            WHERE server_id = ?
            ORDER BY updated_at DESC
          `)
          .all(serverId)
    : getDb()
        .prepare(`
          SELECT id, server_id, sample_type, label, notes, payload_json, version, created_at, updated_at
          FROM server_samples
          ORDER BY updated_at DESC
        `)
        .all();

  return (rows as Array<{
    id: string;
    server_id: string;
    sample_type: ServerSamplePayload["sampleType"];
    label: string;
    notes?: string;
    payload_json: string;
    version: number;
    created_at: number;
    updated_at: number;
  }>).map((row) => ({
    id: row.id,
    serverId: row.server_id,
    sampleType: row.sample_type,
    label: row.label,
    notes: row.notes,
    payloadJson: row.payload_json,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getServerSampleById(id: string): ServerSamplePayload | null {
  const row = getDb()
    .prepare(`
      SELECT id, server_id, sample_type, label, notes, payload_json, version, created_at, updated_at
      FROM server_samples
      WHERE id = ?
      LIMIT 1
    `)
    .get(id) as
    | {
        id: string;
        server_id: string;
        sample_type: ServerSamplePayload["sampleType"];
        label: string;
        notes?: string;
        payload_json: string;
        version: number;
        created_at: number;
        updated_at: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    serverId: row.server_id,
    sampleType: row.sample_type,
    label: row.label,
    notes: row.notes,
    payloadJson: row.payload_json,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deleteServerSample(id: string) {
  const result = getDb().prepare("DELETE FROM server_samples WHERE id = ?").run(id);
  return Number(result.changes || 0) > 0;
}

export function appendHealthHistory(entry: ServerHealthResult) {
  getDb()
    .prepare(`
      INSERT INTO server_health_checks (server_id, server_name, status, checked_at, latency_ms, http_status, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      entry.serverId,
      entry.serverName,
      entry.status,
      entry.checkedAt,
      entry.latencyMs,
      entry.httpStatus ?? null,
      entry.message,
    );
  cleanupHealthHistoryRetention(entry.serverId);
}

export function listHealthHistory(serverId?: string, limit = 20): ServerHealthHistoryEntry[] {
  const rows = serverId
    ? getDb()
        .prepare(`
          SELECT id, server_id, server_name, status, checked_at, latency_ms, http_status, message
          FROM server_health_checks
          WHERE server_id = ?
          ORDER BY checked_at DESC
          LIMIT ?
        `)
        .all(serverId, limit)
    : getDb()
        .prepare(`
          SELECT id, server_id, server_name, status, checked_at, latency_ms, http_status, message
          FROM server_health_checks
          ORDER BY checked_at DESC
          LIMIT ?
        `)
        .all(limit);

  return (rows as Array<{
    id: number;
    server_id: string;
    server_name: string;
    status: ServerHealthHistoryEntry["status"];
    checked_at: number;
    latency_ms: number;
    http_status?: number;
    message: string;
  }>).map((row) => ({
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name,
    status: row.status,
    checkedAt: row.checked_at,
    latencyMs: row.latency_ms,
    httpStatus: row.http_status,
    message: row.message,
  }));
}
