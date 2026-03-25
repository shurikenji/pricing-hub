"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ServerWorkbench } from "@/components/control/ServerWorkbench";
import { getErrorMessage } from "@/lib/error-utils";
import { getServerPreset, SERVER_PRESETS } from "@/lib/server-presets";
import type {
  AdminAuditLog,
  AdminBackupBundle,
  AuthMode,
  BackupImportResponse,
  LogEntry,
  NormalizedGroup,
  NormalizedModel,
  PricingSnapshotDiff,
  PricingSnapshotDiffItem,
  PricingSnapshotSummary,
  ServerConfig,
  ServerHealthRunResponse,
  ServerPresetId,
  ServerType,
  TokenSearchResult,
} from "@/lib/types";

const emptyServer: ServerConfig = {
  id: "",
  name: "",
  baseUrl: "",
  type: "newapi",
  presetId: "newapi_standard",
  supportsGroupChain: false,
  groupSelectionMode: "single",
  groupMatchMode: "union",
  tokenUpdateMode: "newapi_put",
  tokenSearchMode: "search_by_keyword_then_match",
  logResolveMode: "token_name_lookup",
  ratioConfigEnabled: false,
  enabled: true,
  authMode: "header",
  authUserHeader: "New-Api-User",
  authUserValue: "",
  authToken: "",
  authCookie: "",
  pricingPath: "/api/pricing",
  ratioConfigPath: "/api/ratio_config",
  logPath: "/api/log/self",
  tokenSearchPath: "/api/token/search",
  tokenUpdatePath: "/api/token/",
  groupsPath: "/api/user/self/groups",
  notes: "",
  autoSyncEnabled: true,
  autoSyncIntervalMinutes: 180,
  lastPricingSyncStatus: "idle",
  normalizerHintJson: JSON.stringify(
    {
      pricingDataPath: "data",
      ratioMode: "separate_ratio_endpoint",
      groupSelectionMode: "single",
      requestScaledQuotaType: 1,
    },
    null,
    2,
  ),
};

const defaultLabPricingPayload = `{
  "data": []
}`;

const defaultLabLogsPayload = `{
  "data": {
    "items": []
  }
}`;

const defaultLabTokenPayload = `{
  "data": []
}`;

interface NormalizerPreviewResponse {
  success: boolean;
  requestId: string;
  warnings: string[];
  diagnostics?: {
    sourceServerId?: string;
    pricingModelCount: number;
    pricingGroupCount: number;
    logRowCount: number;
    trimmedModelCount: number;
    trimmedLogCount: number;
    detectedModes: Partial<Record<string, number>>;
    unresolvedWarnings: string[];
  };
  pricing?: {
    modelCount: number;
    groupCount: number;
    groups: NormalizedGroup[];
    models: NormalizedModel[];
  };
  pricingError?: string;
  logs?: {
    total: number;
    items: LogEntry[];
  };
  logsError?: string;
  token?: TokenSearchResult | null;
  tokenError?: string;
}

function formatPrice(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 0.001) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function getChangeBadgeClass(item: PricingSnapshotDiffItem) {
  if (item.changeType === "added") return "badge-green";
  if (item.changeType === "removed") return "badge-red";
  return "badge-amber";
}

function formatSyncTime(value: number | undefined) {
  return value ? new Date(value).toLocaleString() : "-";
}

function getHealthBadgeClass(status: ServerConfig["lastHealthStatus"]) {
  if (status === "healthy") return "badge-green";
  if (status === "degraded") return "badge-amber";
  if (status === "down") return "badge-red";
  return "badge-group";
}

function applyPresetToServer(current: ServerConfig, presetId: ServerPresetId) {
  const preset = getServerPreset(presetId);
  if (!preset) {
    return current;
  }

  return {
    ...current,
    ...preset.config,
    presetId: preset.id,
  };
}

export default function ControlPage() {
  const [loginSecret, setLoginSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editServer, setEditServer] = useState<ServerConfig>(emptyServer);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [pricingSnapshots, setPricingSnapshots] = useState<PricingSnapshotSummary[]>([]);
  const [selectedDiffServer, setSelectedDiffServer] = useState("");
  const [pricingDiff, setPricingDiff] = useState<PricingSnapshotDiff | null>(null);
  const [pricingDiffError, setPricingDiffError] = useState("");
  const [message, setMessage] = useState("");
  const [importMode, setImportMode] = useState<"merge" | "replace">("replace");
  const [importingBackup, setImportingBackup] = useState(false);
  const [labServerId, setLabServerId] = useState("");
  const [labHintsJson, setLabHintsJson] = useState(emptyServer.normalizerHintJson || "");
  const [labApiKey, setLabApiKey] = useState("sk-preview");
  const [labPricingPayload, setLabPricingPayload] = useState(defaultLabPricingPayload);
  const [labLogsPayload, setLabLogsPayload] = useState(defaultLabLogsPayload);
  const [labTokenPayload, setLabTokenPayload] = useState(defaultLabTokenPayload);
  const [labLoading, setLabLoading] = useState(false);
  const [labError, setLabError] = useState("");
  const [labResult, setLabResult] = useState<NormalizerPreviewResponse | null>(null);
  const backupFileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchAuditLogs = useCallback(async () => {
    const response = await fetch("/api/admin/audit?limit=12", { credentials: "include" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as AdminAuditLog[];
    setAuditLogs(payload);
  }, []);

  const fetchPricingSnapshots = useCallback(async () => {
    const response = await fetch("/api/admin/pricing-snapshots?limit=12", { credentials: "include" });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as PricingSnapshotSummary[];
    setPricingSnapshots(payload);
  }, []);

  const fetchPricingDiff = useCallback(async (serverId: string) => {
    if (!serverId) {
      setPricingDiff(null);
      setPricingDiffError("");
      return;
    }

    const response = await fetch(`/api/admin/pricing-snapshots?diff=1&server=${encodeURIComponent(serverId)}`, {
      credentials: "include",
    });

    if (response.status === 404) {
      setPricingDiff(null);
      setPricingDiffError("Need at least two snapshots for this server before a diff can be shown.");
      return;
    }

    if (!response.ok) {
      setPricingDiff(null);
      setPricingDiffError("Failed to compare recent pricing snapshots.");
      return;
    }

    const payload = (await response.json()) as PricingSnapshotDiff;
    setPricingDiff(payload);
    setPricingDiffError("");
  }, []);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/servers?admin=1", { credentials: "include" });
      if (res.status === 401) {
        setAuthenticated(false);
        setServers([]);
        return;
      }
      const data = (await res.json()) as ServerConfig[];
      setServers(data);
      setAuthenticated(true);
      setMessage("");
      const nextDiffServer = selectedDiffServer && data.some((server) => server.id === selectedDiffServer) ? selectedDiffServer : data[0]?.id || "";
      setSelectedDiffServer(nextDiffServer);
      await fetchAuditLogs();
      await fetchPricingSnapshots();
      await fetchPricingDiff(nextDiffServer);
    } catch {
      setMessage("Failed to load server configuration.");
    } finally {
      setLoading(false);
    }
  }, [fetchAuditLogs, fetchPricingDiff, fetchPricingSnapshots, selectedDiffServer]);

  useEffect(() => {
    void fetch("/api/admin/session", { credentials: "include" })
      .then((response) => response.json())
      .then((payload: { authenticated?: boolean }) => {
        if (payload.authenticated) {
          void fetchServers();
        }
      });
  }, [fetchServers]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    void fetchPricingDiff(selectedDiffServer);
  }, [authenticated, fetchPricingDiff, selectedDiffServer]);

  useEffect(() => {
    if (labServerId || servers.length === 0) {
      return;
    }

    const firstServer = servers[0];
    setLabServerId(firstServer.id);
    setLabHintsJson(firstServer.normalizerHintJson || emptyServer.normalizerHintJson || "");
  }, [labServerId, servers]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");

    const response = await fetch("/api/admin/session", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: loginSecret }),
    });

    if (!response.ok) {
      setAuthenticated(false);
      setLoading(false);
      setMessage("Invalid admin secret.");
      return;
    }

    setLoginSecret("");
    setAuthenticated(true);
    await fetchServers();
  }

  async function handleLogout() {
    await fetch("/api/admin/session", {
      method: "DELETE",
      credentials: "include",
    });
    setAuthenticated(false);
    setServers([]);
    setAuditLogs([]);
    setPricingDiff(null);
    setPricingDiffError("");
    setShowModal(false);
    setMessage("");
  }

  function openAdd() {
    setEditServer({ ...emptyServer });
    setShowModal(true);
  }

  function openEdit(server: ServerConfig) {
    setEditServer({ ...server });
    setShowModal(true);
  }

  async function handleSave() {
    if (editServer.normalizerHintJson?.trim()) {
      try {
        JSON.parse(editServer.normalizerHintJson);
      } catch {
        setMessage("Normalizer hints must be valid JSON.");
        return;
      }
    }

    const isNew = !servers.some((server) => server.id === editServer.id);
    const res = await fetch("/api/servers", {
      method: isNew ? "POST" : "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editServer),
    });

    if (res.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    if (!res.ok) {
      setMessage("Save failed.");
      return;
    }

    setShowModal(false);
    setEditServer({ ...emptyServer });
    await fetchServers();
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/servers?id=${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    if (res.ok) {
      await fetchServers();
    }
  }

  async function handleToggle(server: ServerConfig) {
    const res = await fetch("/api/servers", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: server.id, enabled: !server.enabled }),
    });
    if (res.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    await fetchServers();
  }

  async function handleSyncPricing(serverId: string) {
    setMessage("");
    const res = await fetch("/api/admin/pricing-snapshots", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId }),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    if (!res.ok) {
      setMessage(payload.error || "Pricing sync failed.");
      return;
    }
    setMessage(`Synced pricing for ${serverId}: ${payload.modelCount} models, ${payload.groupCount} groups.`);
    await fetchServers();
    await fetchPricingDiff(serverId);
  }

  async function handleRunDueJobs() {
    setMessage("");
    const res = await fetch("/api/admin/pricing-snapshots", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runDue: true }),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    if (!res.ok) {
      setMessage(payload.error || "Failed to run due sync jobs.");
      return;
    }

    setMessage(`Ran ${payload.triggeredCount} due jobs: ${payload.successCount} success, ${payload.failureCount} failed.`);
    await fetchServers();
  }

  async function handleRunHealthChecks(serverId?: string) {
    setMessage("");
    const response = await fetch("/api/admin/health", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serverId ? { serverId } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as Partial<ServerHealthRunResponse> & { error?: string };
    if (response.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    if (!response.ok) {
      setMessage(payload.error || "Failed to run health checks.");
      return;
    }

    setMessage(
      `Health check finished: ${payload.healthyCount || 0} healthy, ${payload.degradedCount || 0} degraded, ${payload.downCount || 0} down.`,
    );
    await fetchServers();
  }

  async function handleExportBackup() {
    setMessage("");
    const response = await fetch("/api/admin/backup", { credentials: "include" });
    if (response.status === 401) {
      setAuthenticated(false);
      setMessage("Admin session expired.");
      return;
    }
    if (!response.ok) {
      setMessage("Failed to export backup.");
      return;
    }

    const payload = (await response.json()) as AdminBackupBundle;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pricing-hub-backup-${payload.exportedAt}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage(`Backup exported with ${payload.servers.length} servers and ${payload.pricingSnapshots.length} snapshot summaries.`);
  }

  async function handleImportBackup(file?: File | null) {
    if (!file) {
      setMessage("Select a backup file first.");
      return;
    }

    setImportingBackup(true);
    setMessage("");

    try {
      const raw = await file.text();
      const bundle = JSON.parse(raw) as AdminBackupBundle;
      const response = await fetch("/api/admin/backup", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: importMode, bundle }),
      });
      const payload = (await response.json()) as Partial<BackupImportResponse> & { error?: string };

      if (response.status === 401) {
        setAuthenticated(false);
        setMessage("Admin session expired.");
        return;
      }
      if (!response.ok) {
        setMessage(payload.error || "Failed to import backup.");
        return;
      }

      setMessage(
        `Imported ${payload.importedServers || 0} servers, removed ${payload.removedServers || 0}, skipped ${payload.skippedSnapshotSummaries || 0} snapshot summaries.`,
      );
      if (backupFileInputRef.current) {
        backupFileInputRef.current.value = "";
      }
      await fetchServers();
    } catch {
      setMessage("Backup file is invalid JSON.");
    } finally {
      setImportingBackup(false);
    }
  }

  function handleLoadLabServerConfig() {
    const server = servers.find((item) => item.id === labServerId);
    if (!server) {
      setLabError("Pick a server before loading normalizer hints.");
      return;
    }

    setLabHintsJson(server.normalizerHintJson || "");
    setLabError("");
    setLabResult(null);
    setMessage(`Loaded normalizer hints from ${server.name}.`);
  }

  async function handleRunNormalizerPreview() {
    setLabLoading(true);
    setLabError("");
    setLabResult(null);

    const response = await fetch("/api/admin/normalizer-preview", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: labServerId || undefined,
        hintsJson: labHintsJson,
        pricingPayload: labPricingPayload,
        logsPayload: labLogsPayload,
        tokenPayload: labTokenPayload,
        apiKey: labApiKey,
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as NormalizerPreviewResponse & { error?: string };
    if (response.status === 401) {
      setAuthenticated(false);
      setLabLoading(false);
      setLabError("Admin session expired.");
      return;
    }
    if (!response.ok) {
      setLabLoading(false);
      setLabError(getErrorMessage(payload, "Failed to preview normalizer output."));
      return;
    }

    setLabResult(payload);
    setLabLoading(false);
  }

  function handleLoadSampleToLab(sample: { serverId: string; sampleType: "pricing" | "logs" | "token"; payloadJson: string }) {
    setLabServerId(sample.serverId);
    if (sample.sampleType === "pricing") {
      setLabPricingPayload(sample.payloadJson);
    }
    if (sample.sampleType === "logs") {
      setLabLogsPayload(sample.payloadJson);
    }
    if (sample.sampleType === "token") {
      setLabTokenPayload(sample.payloadJson);
    }
    setMessage(`Loaded ${sample.sampleType} sample into Normalizer Lab.`);
  }

  function handleLoadHintsToLab(server: ServerConfig) {
    setLabServerId(server.id);
    setLabHintsJson(server.normalizerHintJson || "");
    setMessage(`Loaded normalizer hints from ${server.name} into Normalizer Lab.`);
  }

  function updateField<K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) {
    setEditServer((current) => ({ ...current, [key]: value }));
  }

  function handleApplyPreset(presetId: ServerPresetId) {
    setEditServer((current) => applyPresetToServer(current, presetId));
  }

  if (!authenticated) {
    return (
      <div style={{ maxWidth: 520, margin: "64px auto" }}>
        <div className="page-header">
          <h2 className="page-title">Control Center</h2>
          <p className="page-description">Admin auth now uses an HttpOnly session cookie instead of storing the secret in the browser.</p>
        </div>

        <div className="card">
          <form onSubmit={(event) => void handleLogin(event)}>
            <div className="form-group">
              <label className="form-label">Admin Secret</label>
              <input
                type="password"
                value={loginSecret}
                onChange={(event) => setLoginSecret(event.target.value)}
                placeholder="Enter admin secret"
              />
            </div>
            {message ? <p style={{ color: "var(--red)" }}>{message}</p> : null}
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? "Checking..." : "Open Control Center"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Control Center</h1>
        <p className="page-description">
          Manage upstream servers, auth headers, and endpoint mappings without exposing secrets to users.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button className="btn btn-ghost" onClick={() => void handleRunHealthChecks()} style={{ marginRight: 12 }}>
          Run Health Checks
        </button>
        <button className="btn btn-primary" onClick={() => void handleRunDueJobs()} style={{ marginRight: 12 }}>
          Run Due Jobs
        </button>
        <button className="btn btn-ghost" onClick={() => void handleLogout()}>
          Logout
        </button>
      </div>

      {message ? (
        <div className="card" style={{ marginBottom: 24, borderColor: "rgba(99, 102, 241, 0.35)" }}>
          <div className="card-subtitle" style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            {message}
          </div>
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="card-title">Backup Center</div>
            <div className="card-subtitle">Export a restore bundle with server configs and snapshot summaries, or import one to recover configuration quickly.</div>
          </div>
          <button className="btn btn-ghost" onClick={() => void handleExportBackup()}>
            Export Backup
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, alignItems: "end" }}>
          <div className="form-group">
            <label className="form-label">Import Mode</label>
            <select value={importMode} onChange={(event) => setImportMode(event.target.value as "merge" | "replace")}>
              <option value="replace">replace</option>
              <option value="merge">merge</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Backup File</label>
            <input ref={backupFileInputRef} type="file" accept="application/json" />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn btn-primary"
              onClick={() => void handleImportBackup(backupFileInputRef.current?.files?.[0])}
              disabled={importingBackup}
            >
              {importingBackup ? "Importing..." : "Import Backup"}
            </button>
          </div>
        </div>
      </div>

      <ServerWorkbench
        servers={servers}
        onLoadSampleToLab={handleLoadSampleToLab}
        onLoadHintsToLab={handleLoadHintsToLab}
        onMessage={setMessage}
      />

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="card-title">Normalizer Lab</div>
            <div className="card-subtitle">
              Paste raw upstream JSON, apply mapping hints, and inspect the normalized pricing, logs, and token shape before touching a live sync.
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-ghost" onClick={handleLoadLabServerConfig}>
              Load Server Hints
            </button>
            <button className="btn btn-primary" onClick={() => void handleRunNormalizerPreview()} disabled={labLoading}>
              {labLoading ? "Running..." : "Run Preview"}
            </button>
          </div>
        </div>

        <div className="lab-grid" style={{ marginBottom: 18 }}>
          <div className="lab-panel">
            <div className="form-group">
              <label className="form-label">Baseline Server</label>
              <select value={labServerId} onChange={(event) => setLabServerId(event.target.value)}>
                <option value="">preview-only</option>
                {servers.map((server) => (
                  <option key={server.id} value={server.id}>
                    {server.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">API Key Hint</label>
              <input value={labApiKey} onChange={(event) => setLabApiKey(event.target.value)} placeholder="Used only to resolve token payload matching" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Normalizer Hints (JSON)</label>
              <textarea className="lab-code" value={labHintsJson} onChange={(event) => setLabHintsJson(event.target.value)} rows={16} />
            </div>
          </div>

          <div className="lab-panel">
            <div className="form-group">
              <label className="form-label">Pricing Payload</label>
              <textarea className="lab-code" value={labPricingPayload} onChange={(event) => setLabPricingPayload(event.target.value)} rows={10} />
            </div>
            <div className="form-group">
              <label className="form-label">Logs Payload</label>
              <textarea className="lab-code" value={labLogsPayload} onChange={(event) => setLabLogsPayload(event.target.value)} rows={10} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Token Payload</label>
              <textarea className="lab-code" value={labTokenPayload} onChange={(event) => setLabTokenPayload(event.target.value)} rows={8} />
            </div>
          </div>
        </div>

        {labError ? (
          <div className="card-subtitle" style={{ color: "var(--red)", marginBottom: 14 }}>
            {labError}
          </div>
        ) : null}

        {labResult ? (
          <div className="lab-stack">
            <div className="stats-row" style={{ marginBottom: 12 }}>
              <div className="stat-card">
                <div className="stat-label">Request ID</div>
                <div className="stat-note">{labResult.requestId}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Pricing Models</div>
                <div className="stat-value">{labResult.pricing?.modelCount || 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Pricing Groups</div>
                <div className="stat-value">{labResult.pricing?.groupCount || 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Log Rows</div>
                <div className="stat-value">{labResult.logs?.total || 0}</div>
              </div>
            </div>

            {labResult.warnings.length > 0 ? (
              <div className="lab-warning-list">
                {labResult.warnings.map((warning) => (
                  <span key={warning} className="badge badge-amber">
                    {warning}
                  </span>
                ))}
              </div>
            ) : null}

            {labResult.diagnostics ? (
              <div className="stats-row" style={{ marginBottom: 0 }}>
                <div className="stat-card">
                  <div className="stat-label">Detected Modes</div>
                  <div className="stat-note">
                    {Object.entries(labResult.diagnostics.detectedModes).length === 0
                      ? "none"
                      : Object.entries(labResult.diagnostics.detectedModes)
                          .map(([mode, count]) => `${mode}:${count}`)
                          .join(" · ")}
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Trimmed Models</div>
                  <div className="stat-value">{labResult.diagnostics.trimmedModelCount}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Trimmed Logs</div>
                  <div className="stat-value">{labResult.diagnostics.trimmedLogCount}</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Unresolved Hints</div>
                  <div className="stat-value">{labResult.diagnostics.unresolvedWarnings.length}</div>
                </div>
              </div>
            ) : null}

            <div className="lab-result-grid">
              <div className="lab-panel">
                <div className="card-title" style={{ marginBottom: 10 }}>Pricing Preview</div>
                {labResult.pricingError ? (
                  <div className="card-subtitle" style={{ color: "var(--red)" }}>{labResult.pricingError}</div>
                ) : labResult.pricing ? (
                  <>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                      {labResult.pricing.groups.map((group) => (
                        <span key={group.name} className="badge badge-group">
                          {group.displayName} x{group.ratio}
                        </span>
                      ))}
                    </div>
                    <div className="table-wrapper">
                      <table>
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th>Mode</th>
                            <th>Input</th>
                            <th>Output</th>
                            <th>Request</th>
                          </tr>
                        </thead>
                        <tbody>
                          {labResult.pricing.models.map((model) => (
                            <tr key={model.modelName}>
                              <td>{model.modelName}</td>
                              <td><span className="badge badge-group">{model.pricingMode}</span></td>
                              <td>{formatPrice(model.inputPricePer1M)}</td>
                              <td>{formatPrice(model.outputPricePer1M)}</td>
                              <td>{formatPrice(model.requestPrice)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <div className="card-subtitle">No pricing payload submitted.</div>
                )}
              </div>

              <div className="lab-panel">
                <div className="card-title" style={{ marginBottom: 10 }}>Logs Preview</div>
                {labResult.logsError ? (
                  <div className="card-subtitle" style={{ color: "var(--red)" }}>{labResult.logsError}</div>
                ) : labResult.logs ? (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>Model</th>
                          <th>Group</th>
                          <th>Mode</th>
                          <th>Quota</th>
                          <th>USD</th>
                        </tr>
                      </thead>
                      <tbody>
                        {labResult.logs.items.map((item, index) => (
                          <tr key={`${item.id}-${index}`}>
                            <td>{item.model || "-"}</td>
                            <td>{item.group || "-"}</td>
                            <td><span className="badge badge-group">{item.pricingMode || "unknown"}</span></td>
                            <td>{item.quota}</td>
                            <td>{formatPrice(item.estimatedUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="card-subtitle">No logs payload submitted.</div>
                )}
              </div>

              <div className="lab-panel">
                <div className="card-title" style={{ marginBottom: 10 }}>Token Preview</div>
                {labResult.tokenError ? (
                  <div className="card-subtitle" style={{ color: "var(--red)" }}>{labResult.tokenError}</div>
                ) : labResult.token ? (
                  <div className="lab-token-stack">
                    <div className="stat-note">Matched token payload against the API key hint.</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <span className="badge badge-green">{labResult.token.name || "unnamed-token"}</span>
                      {labResult.token.id ? <span className="badge badge-group">id {labResult.token.id}</span> : null}
                    </div>
                    <div className="stats-row" style={{ marginBottom: 0 }}>
                      <div className="stat-card">
                        <div className="stat-label">Remain Quota</div>
                        <div className="stat-value">{labResult.token.remainQuota ?? "-"}</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Used Quota</div>
                        <div className="stat-value">{labResult.token.usedQuota ?? "-"}</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="card-subtitle">No matching token found in the payload.</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-label">Servers</div>
          <div className="stat-value">{servers.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Enabled</div>
          <div className="stat-value">{servers.filter((server) => server.enabled).length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">NewAPI</div>
          <div className="stat-value">{servers.filter((server) => server.type === "newapi").length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">RixAPI</div>
          <div className="stat-value">{servers.filter((server) => server.type === "rixapi").length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Auto Sync</div>
          <div className="stat-value">{servers.filter((server) => server.autoSyncEnabled).length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Healthy</div>
          <div className="stat-value">{servers.filter((server) => server.lastHealthStatus === "healthy").length}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <div className="card-title">Server Registry</div>
            <div className="card-subtitle">Secrets are visible only in this admin route.</div>
          </div>
          <button className="btn btn-primary" onClick={openAdd}>
            Add Server
          </button>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Preset</th>
                <th>Type</th>
                <th>Base URL</th>
                <th>Health</th>
                <th>Latency</th>
                <th>Auth</th>
                <th>Group Mode</th>
                <th>Auto Sync</th>
                <th>Next Run</th>
                <th>Last Sync</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id}>
                  <td>{server.id}</td>
                  <td>{server.name}</td>
                  <td>
                    <span className="badge badge-group">{getServerPreset(server.presetId)?.label || server.presetId || "manual"}</span>
                  </td>
                  <td>{server.type}</td>
                  <td>{server.baseUrl}</td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className={`badge ${getHealthBadgeClass(server.lastHealthStatus)}`}>
                        {server.lastHealthStatus || "unknown"}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {formatSyncTime(server.lastHealthCheckAt)}
                      </span>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span>{server.lastHealthLatencyMs ? `${server.lastHealthLatencyMs} ms` : "-"}</span>
                      {server.lastHealthHttpStatus ? (
                        <span className="badge badge-group">HTTP {server.lastHealthHttpStatus}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>{server.authMode || "header"}</td>
                  <td>{server.groupSelectionMode || (server.supportsGroupChain ? "chain" : "single")}</td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span className={`badge ${server.autoSyncEnabled ? "badge-green" : "badge-group"}`}>
                        {server.autoSyncEnabled ? `Every ${server.autoSyncIntervalMinutes || 180}m` : "Off"}
                      </span>
                      {server.lastPricingSyncStatus === "error" && server.lastPricingSyncError ? (
                        <span style={{ color: "var(--red)", fontSize: 11, maxWidth: 220, whiteSpace: "pre-wrap" }}>
                          {server.lastPricingSyncError}
                        </span>
                      ) : null}
                      {server.lastHealthMessage ? (
                        <span style={{ color: "var(--text-muted)", fontSize: 11, maxWidth: 220, whiteSpace: "pre-wrap" }}>
                          {server.lastHealthMessage}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>{formatSyncTime(server.nextPricingSyncAt)}</td>
                  <td>{formatSyncTime(server.lastPricingSyncAt)}</td>
                  <td>
                    <button
                      className={`badge ${server.enabled ? "badge-green" : "badge-red"}`}
                      onClick={() => void handleToggle(server)}
                      style={{ border: "none", cursor: "pointer" }}
                    >
                      {server.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="btn btn-ghost" onClick={() => void handleSyncPricing(server.id)}>
                        Sync Pricing
                      </button>
                      <button className="btn btn-ghost" onClick={() => void handleRunHealthChecks(server.id)}>
                        Check Health
                      </button>
                      <button className="btn btn-ghost" onClick={() => openEdit(server)}>
                        Edit
                      </button>
                      <button className="btn btn-danger" onClick={() => void handleDelete(server.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <div className="card-title">Recent Pricing Snapshots</div>
            <div className="card-subtitle">History of pricing syncs captured from upstream servers.</div>
          </div>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Server</th>
                <th>Models</th>
                <th>Groups</th>
              </tr>
            </thead>
            <tbody>
              {pricingSnapshots.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                    No pricing snapshot stored yet.
                  </td>
                </tr>
              ) : (
                pricingSnapshots.map((snapshot) => (
                  <tr key={snapshot.id}>
                    <td>{new Date(snapshot.fetchedAt).toLocaleString()}</td>
                    <td>{snapshot.serverName}</td>
                    <td>{snapshot.modelCount}</td>
                    <td>{snapshot.groupCount}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="card-title">Pricing Drift Monitor</div>
            <div className="card-subtitle">Compare the latest two snapshots of a server to spot added, removed, or repriced models.</div>
          </div>
          <div style={{ minWidth: 240 }}>
            <label className="form-label">Server</label>
            <select value={selectedDiffServer} onChange={(event) => setSelectedDiffServer(event.target.value)}>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {pricingDiff ? (
          <>
            <div className="stats-row" style={{ marginBottom: 20 }}>
              <div className="stat-card">
                <div className="stat-label">Compared</div>
                <div className="stat-value">{pricingDiff.serverName}</div>
                <div className="stat-note">
                  {new Date(pricingDiff.baseFetchedAt).toLocaleString()} → {new Date(pricingDiff.compareFetchedAt).toLocaleString()}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Added</div>
                <div className="stat-value" style={{ color: "var(--green)" }}>{pricingDiff.addedCount}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Removed</div>
                <div className="stat-value" style={{ color: "var(--red)" }}>{pricingDiff.removedCount}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Updated</div>
                <div className="stat-value" style={{ color: "var(--amber)" }}>{pricingDiff.updatedCount}</div>
              </div>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Change</th>
                    <th>Mode</th>
                    <th>Input / 1M</th>
                    <th>Output / 1M</th>
                    <th>Request</th>
                    <th>Groups</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingDiff.items.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: 24 }}>
                        Latest snapshots are identical for this server.
                      </td>
                    </tr>
                  ) : (
                    pricingDiff.items.map((item) => (
                      <tr key={`${item.changeType}-${item.modelName}`}>
                        <td>{item.modelName}</td>
                        <td>
                          <span className={`badge ${getChangeBadgeClass(item)}`}>{item.changeType}</span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {item.pricingModeBefore ? <span className="badge badge-group">{item.pricingModeBefore}</span> : null}
                            {item.pricingModeAfter && item.pricingModeAfter !== item.pricingModeBefore ? <span className="badge badge-accent">{item.pricingModeAfter}</span> : null}
                          </div>
                        </td>
                        <td>{formatPrice(item.inputBefore)} → {formatPrice(item.inputAfter)}</td>
                        <td>{formatPrice(item.outputBefore)} → {formatPrice(item.outputAfter)}</td>
                        <td>{formatPrice(item.requestBefore)} → {formatPrice(item.requestAfter)}</td>
                        <td>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {item.groupsAfter.length > 0 ? item.groupsAfter.map((group) => (
                              <span key={`${item.modelName}-${group}`} className="badge badge-green">
                                {group}
                              </span>
                            )) : item.groupsBefore.map((group) => (
                              <span key={`${item.modelName}-${group}`} className="badge badge-group">
                                {group}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ padding: "36px 20px" }}>
            <div className="empty-icon">Δ</div>
            <p>{pricingDiffError || "No diff is available yet for the selected server."}</p>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <div className="card-title">Recent Activity</div>
            <div className="card-subtitle">Audit trail for changes made inside the control center.</div>
          </div>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Target</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", padding: 24 }}>
                    No admin activity logged yet.
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                    <td>{log.action}</td>
                    <td>{log.targetId || log.targetType}</td>
                    <td style={{ maxWidth: 520, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {log.detail || "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal ? (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(860px, 92vw)" }}>
            <h3 className="modal-title">
              {servers.some((server) => server.id === editServer.id) ? "Edit server" : "Add server"}
            </h3>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
              <div className="form-group">
                <label className="form-label">Preset</label>
                <select value={editServer.presetId || "custom_manual"} onChange={(event) => updateField("presetId", event.target.value as ServerPresetId)}>
                  {SERVER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", alignItems: "end" }}>
                <button className="btn btn-ghost" onClick={() => handleApplyPreset((editServer.presetId || "custom_manual") as ServerPresetId)}>
                  Apply Preset
                </button>
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Preset Description</label>
                <div className="card-subtitle">
                  {getServerPreset(editServer.presetId || "custom_manual")?.description || "Manual configuration preset."}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Server ID</label>
                <input value={editServer.id} onChange={(event) => updateField("id", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input value={editServer.name} onChange={(event) => updateField("name", event.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Base URL</label>
                <input value={editServer.baseUrl} onChange={(event) => updateField("baseUrl", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Server Type</label>
                <select value={editServer.type} onChange={(event) => updateField("type", event.target.value as ServerType)}>
                  <option value="newapi">newapi</option>
                  <option value="rixapi">rixapi</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Group Selection</label>
                <select
                  value={editServer.groupSelectionMode || "single"}
                  onChange={(event) => {
                    const value = event.target.value as ServerConfig["groupSelectionMode"];
                    updateField("groupSelectionMode", value);
                    updateField("supportsGroupChain", value !== "single");
                  }}
                >
                  <option value="single">single</option>
                  <option value="chain">chain</option>
                  <option value="multi_union">multi_union</option>
                  <option value="multi_intersection">multi_intersection</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Group Match</label>
                <select
                  value={editServer.groupMatchMode || "union"}
                  onChange={(event) => updateField("groupMatchMode", event.target.value as ServerConfig["groupMatchMode"])}
                >
                  <option value="union">union</option>
                  <option value="intersection">intersection</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Auth Mode</label>
                <select value={editServer.authMode || "header"} onChange={(event) => updateField("authMode", event.target.value as AuthMode)}>
                  <option value="header">header</option>
                  <option value="bearer">bearer</option>
                  <option value="cookie">cookie</option>
                  <option value="none">none</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Token Update Mode</label>
                <select
                  value={editServer.tokenUpdateMode || "newapi_put"}
                  onChange={(event) => updateField("tokenUpdateMode", event.target.value as ServerConfig["tokenUpdateMode"])}
                >
                  <option value="newapi_put">newapi_put</option>
                  <option value="rixapi_put">rixapi_put</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Token Search Mode</label>
                <select
                  value={editServer.tokenSearchMode || "search_by_keyword_then_match"}
                  onChange={(event) => updateField("tokenSearchMode", event.target.value as ServerConfig["tokenSearchMode"])}
                >
                  <option value="search_by_key">search_by_key</option>
                  <option value="search_by_keyword_then_match">search_by_keyword_then_match</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Log Resolve Mode</label>
                <select
                  value={editServer.logResolveMode || "token_name_lookup"}
                  onChange={(event) => updateField("logResolveMode", event.target.value as ServerConfig["logResolveMode"])}
                >
                  <option value="token_name_lookup">token_name_lookup</option>
                  <option value="direct_credentials">direct_credentials</option>
                  <option value="custom">custom</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">User Header</label>
                <input value={editServer.authUserHeader || ""} onChange={(event) => updateField("authUserHeader", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">User Value</label>
                <input value={editServer.authUserValue || ""} onChange={(event) => updateField("authUserValue", event.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Access Token</label>
                <input type="password" value={editServer.authToken || ""} onChange={(event) => updateField("authToken", event.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Cookie</label>
                <input value={editServer.authCookie || ""} onChange={(event) => updateField("authCookie", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Pricing Path</label>
                <input value={editServer.pricingPath || ""} onChange={(event) => updateField("pricingPath", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Ratio Path</label>
                <input value={editServer.ratioConfigPath || ""} onChange={(event) => updateField("ratioConfigPath", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Log Path</label>
                <input value={editServer.logPath || ""} onChange={(event) => updateField("logPath", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Token Search Path</label>
                <input value={editServer.tokenSearchPath || ""} onChange={(event) => updateField("tokenSearchPath", event.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">Token Update Path</label>
                <input value={editServer.tokenUpdatePath || ""} onChange={(event) => updateField("tokenUpdatePath", event.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Groups Path</label>
                <input value={editServer.groupsPath || ""} onChange={(event) => updateField("groupsPath", event.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Notes</label>
                <textarea value={editServer.notes || ""} onChange={(event) => updateField("notes", event.target.value)} rows={4} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Normalizer Hints (JSON)</label>
                <textarea
                  value={editServer.normalizerHintJson || ""}
                  onChange={(event) => updateField("normalizerHintJson", event.target.value)}
                  rows={8}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Auto Sync Interval (minutes)</label>
                <input
                  type="number"
                  min={5}
                  value={editServer.autoSyncIntervalMinutes || 180}
                  onChange={(event) => updateField("autoSyncIntervalMinutes", Number(event.target.value) || 180)}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
              <label>
                <input type="checkbox" checked={editServer.supportsGroupChain} disabled /> Group chain (derived)
              </label>
              <label>
                <input type="checkbox" checked={editServer.ratioConfigEnabled} onChange={(event) => updateField("ratioConfigEnabled", event.target.checked)} /> Ratio config
              </label>
              <label>
                <input type="checkbox" checked={editServer.enabled} onChange={(event) => updateField("enabled", event.target.checked)} /> Enabled
              </label>
              <label>
                <input type="checkbox" checked={editServer.autoSyncEnabled || false} onChange={(event) => updateField("autoSyncEnabled", event.target.checked)} /> Auto sync
              </label>
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void handleSave()}>
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
