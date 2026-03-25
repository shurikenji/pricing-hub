"use client";

import { useEffect, useState } from "react";

import { buildCsv, triggerCsvDownload } from "@/lib/csv";
import { getErrorMessage } from "@/lib/error-utils";
import type { LogEntry, PricingMode } from "@/lib/types";

interface ServerOption {
  id: string;
  name: string;
}

function formatMode(mode: PricingMode | undefined) {
  if (mode === "request_scaled") return "Request-scaled";
  if (mode === "token") return "Token";
  if (mode === "fixed") return "Fixed";
  return "Unknown";
}

function formatPrice(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 0.001) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

export default function LogsPage() {
  const initialParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [serverId, setServerId] = useState(initialParams.get("server") || "");
  const [apiKey, setApiKey] = useState("");
  const [tokenName, setTokenName] = useState(initialParams.get("token") || "");
  const [modelName, setModelName] = useState(initialParams.get("model") || "");
  const [startDate, setStartDate] = useState(initialParams.get("start") || "");
  const [endDate, setEndDate] = useState(initialParams.get("end") || "");
  const [group, setGroup] = useState(initialParams.get("group") || "");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [resolution, setResolution] = useState<{ tokenName?: string; warning?: string }>({});

  useEffect(() => {
    void fetch("/api/servers")
      .then((response) => response.json())
      .then((data: ServerOption[]) => {
        setServers(data);
        if (data.length > 0) {
          setServerId((current) => current || data[0].id);
        }
      });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (serverId) params.set("server", serverId);
    if (tokenName) params.set("token", tokenName);
    if (modelName) params.set("model", modelName);
    if (group) params.set("group", group);
    if (startDate) params.set("start", startDate);
    if (endDate) params.set("end", endDate);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [endDate, group, modelName, serverId, startDate, tokenName]);

  async function fetchLogs(nextPage = 1) {
    if (!serverId || (!apiKey && !tokenName)) {
      setError("Enter a server and either API key or token name.");
      return;
    }

    setLoading(true);
    setError("");
    setSearched(true);

    const body: Record<string, unknown> = {
      serverId,
      apiKey: apiKey || undefined,
      tokenName: tokenName || undefined,
      modelName: modelName || undefined,
      group: group || undefined,
      page: nextPage,
      pageSize: 50,
      startTimestamp: startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined,
      endTimestamp: endDate ? Math.floor(new Date(endDate).getTime() / 1000) : undefined,
    };

    const response = await fetch("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(getErrorMessage(payload, "Failed to load usage logs."));
      setLogs([]);
      setLoading(false);
      return;
    }

    setLogs(payload.items || []);
    setTotal(payload.total || 0);
    setPage(nextPage);
    setResolution({ tokenName: payload.resolvedTokenName, warning: payload.resolutionWarning });
    setLoading(false);
  }

  const totalPages = Math.max(1, Math.ceil(total / 50));
  const totalEstimated = logs.reduce((sum, log) => sum + (log.estimatedUsd || 0), 0);

  function exportCsv() {
    const csv = buildCsv(
      ["time", "model", "group", "token", "mode", "prompt_tokens", "completion_tokens", "quota", "estimated_usd", "latency_seconds"],
      logs.map((log) => [
        new Date(log.createdAt * 1000).toISOString(),
        log.model,
        log.group,
        log.tokenName,
        log.pricingMode,
        log.promptTokens,
        log.completionTokens,
        log.quota,
        log.estimatedUsd,
        log.useTime,
      ]),
    );
    triggerCsvDownload(`logs-${serverId || "server"}.csv`, csv);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Usage Logs</h1>
        <p className="page-description">
          Resolve usage history from an API key server-side so admin credentials never reach the browser.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>How Log Lookup Works</div>
        <div className="card-subtitle">
          When you provide an API key, the server resolves the token name server-side and fetches logs without exposing admin credentials to the browser. `Estimated cost` is derived from normalized pricing metadata when the upstream includes enough fields.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <div className="card-title">Lookup Filters</div>
            <div className="card-subtitle">API key is preferred. Token name stays available as fallback filtering.</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Server</label>
            <select value={serverId} onChange={(event) => setServerId(event.target.value)}>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">API Key</label>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
          </div>
          <div className="form-group">
            <label className="form-label">Token Name</label>
            <input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="Optional fallback" />
          </div>
          <div className="form-group">
            <label className="form-label">Model</label>
            <input value={modelName} onChange={(event) => setModelName(event.target.value)} placeholder="Optional" />
          </div>
          <div className="form-group">
            <label className="form-label">Group</label>
            <input value={group} onChange={(event) => setGroup(event.target.value)} placeholder="Optional" />
          </div>
          <div className="form-group">
            <label className="form-label">Start</label>
            <input type="datetime-local" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">End</label>
            <input type="datetime-local" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </div>
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => void fetchLogs(1)} disabled={loading}>
            {loading ? "Loading..." : "Fetch Logs"}
          </button>
          <button className="btn btn-ghost" onClick={exportCsv} disabled={logs.length === 0}>
            Export CSV
          </button>
          {resolution.tokenName ? <span className="badge badge-cyan">Resolved token: {resolution.tokenName}</span> : null}
        </div>
        {resolution.warning ? <p style={{ marginTop: 12, color: "var(--text-secondary)", fontSize: 13 }}>{resolution.warning}</p> : null}
      </div>

      {error ? (
        <div className="empty-state">
          <div className="empty-icon">!</div>
          <p>{error}</p>
        </div>
      ) : null}

      {searched && !loading ? (
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-label">Records</div>
            <div className="stat-value">{total}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Estimated Cost</div>
            <div className="stat-value">{formatPrice(totalEstimated)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Prompt Tokens</div>
            <div className="stat-value">{logs.reduce((sum, log) => sum + log.promptTokens, 0).toLocaleString()}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Completion Tokens</div>
            <div className="stat-value">{logs.reduce((sum, log) => sum + log.completionTokens, 0).toLocaleString()}</div>
          </div>
        </div>
      ) : null}

      {logs.length > 0 ? (
        <>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Model</th>
                  <th>Group</th>
                  <th>Token</th>
                  <th>Mode</th>
                  <th>Prompt</th>
                  <th>Completion</th>
                  <th>Quota</th>
                  <th>Estimated</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={`${log.id}-${log.createdAt}`}>
                    <td>{new Date(log.createdAt * 1000).toLocaleString()}</td>
                    <td>{log.model}</td>
                    <td><span className="badge badge-group">{log.group}</span></td>
                    <td>{log.tokenName}</td>
                    <td><span className="badge badge-accent">{formatMode(log.pricingMode)}</span></td>
                    <td>{log.promptTokens.toLocaleString()}</td>
                    <td>{log.completionTokens.toLocaleString()}</td>
                    <td>{log.quota.toLocaleString()}</td>
                    <td>{formatPrice(log.estimatedUsd)}</td>
                    <td>{log.useTime}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 ? (
            <div className="pagination">
              <button disabled={page <= 1} onClick={() => void fetchLogs(page - 1)}>
                Prev
              </button>
              <span className="page-info">Page {page} / {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => void fetchLogs(page + 1)}>
                Next
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {searched && !loading && logs.length === 0 && !error ? (
        <div className="empty-state">
          <div className="empty-icon">0</div>
          <p>No usage log matched the current filters.</p>
        </div>
      ) : null}
    </>
  );
}
