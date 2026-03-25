"use client";

import { useEffect, useMemo, useState } from "react";

import { getErrorMessage } from "@/lib/error-utils";
import type { KeyResolveResponse, NormalizedPricing, PricingMode } from "@/lib/types";

interface ServerOption {
  id: string;
  name: string;
  supportsGroupChain: boolean;
}

function modeLabel(mode: PricingMode) {
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

export default function KeysPage() {
  const initialParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [serverId, setServerId] = useState(initialParams.get("server") || "");
  const [pricing, setPricing] = useState<NormalizedPricing | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set((initialParams.get("groups") || "").split(",").filter(Boolean)));
  const [loadingPricing, setLoadingPricing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resolveResult, setResolveResult] = useState<KeyResolveResponse | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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
    if (selectedGroups.size > 0) params.set("groups", Array.from(selectedGroups).join(","));
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [selectedGroups, serverId]);

  useEffect(() => {
    if (!serverId) return;
    setLoadingPricing(true);
    setSelectedGroups(new Set());
    setResolveResult(null);
    void fetch(`/api/pricing?server=${serverId}`)
      .then((response) => response.json())
      .then((data: NormalizedPricing) => setPricing(data))
      .finally(() => setLoadingPricing(false));
  }, [serverId]);

  const currentServer = servers.find((server) => server.id === serverId);
  const supportsChain = currentServer?.supportsGroupChain ?? false;

  function toggleGroup(name: string) {
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        if (!supportsChain) {
          next.clear();
        }
        next.add(name);
      }
      return next;
    });
  }

  async function resolveKey() {
    if (!serverId || !apiKey) {
      setError("Enter server and API key first.");
      return;
    }

    setResolving(true);
    setError("");
    setMessage("");

    const response = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, apiKey }),
    });
    const payload = await response.json();

    if (!response.ok) {
      setResolveResult(null);
      setError(getErrorMessage(payload, "Failed to resolve API key."));
      setResolving(false);
      return;
    }

    setResolveResult(payload);
    setSelectedGroups(new Set(payload.token.currentGroups));
    setResolving(false);
  }

  async function saveGroups() {
    if (!serverId || !apiKey || selectedGroups.size === 0) {
      setError("Select at least one group before saving.");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");

    const response = await fetch("/api/keys", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId, apiKey, groups: Array.from(selectedGroups) }),
    });
    const payload = await response.json();

    if (!response.ok) {
      setError(getErrorMessage(payload, "Failed to update API key groups."));
      setSaving(false);
      return;
    }

    setMessage(`Updated groups for ${payload.tokenName || resolveResult?.token.name || "token"}.`);
    setResolveResult((current) =>
      current
        ? {
            ...current,
            token: {
              ...current.token,
              currentGroups: payload.currentGroups,
            },
          }
        : current,
    );
    setSaving(false);
  }

  const availableModels = useMemo(() => {
    if (!pricing) return [];
    if (selectedGroups.size === 0) return pricing.models;
    const matchMode = resolveResult?.matchMode || "union";
    return pricing.models.filter((model) =>
      matchMode === "intersection"
        ? Array.from(selectedGroups).every((group) => model.enableGroups.includes(group))
        : model.enableGroups.some((group) => selectedGroups.has(group)),
    );
  }, [pricing, resolveResult, selectedGroups]);

  const groupModelCounts = useMemo(() => {
    if (!pricing) return {} as Record<string, number>;
    return Object.fromEntries(
      pricing.groups.map((group) => [
        group.name,
        pricing.models.filter((model) => model.enableGroups.includes(group.name)).length,
      ]),
    );
  }, [pricing]);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">API Key Manager</h1>
        <p className="page-description">
          Resolve a key on the selected server, inspect current groups, and update group access without exposing admin credentials.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>How Group Matching Works</div>
        <div className="card-subtitle">
          Some servers allow only one group, while others allow chains or multi-group selection. `matchMode=union` shows models available in any selected group; `matchMode=intersection` shows only models present in all selected groups.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-header">
          <div>
            <div className="card-title">Key Resolution</div>
            <div className="card-subtitle">The selected server decides whether one group or a group chain is allowed.</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
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
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => void resolveKey()} disabled={resolving || !apiKey}>
            {resolving ? "Resolving..." : "Resolve Key"}
          </button>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            {supportsChain ? "Multi-group chain enabled for this server." : "Single-group selection only for this server."}
          </span>
          {resolveResult ? <span className="badge badge-group">{resolveResult.selectionMode}</span> : null}
          {resolveResult ? <span className="badge badge-group">{resolveResult.matchMode}</span> : null}
        </div>
        {error ? <p style={{ marginTop: 12, color: "var(--red)" }}>{error}</p> : null}
        {message ? <p style={{ marginTop: 12, color: "var(--green)" }}>{message}</p> : null}
      </div>

      {resolveResult ? (
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-label">Token</div>
            <div className="stat-value">{resolveResult.token.name || "Unnamed"}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Current Groups</div>
            <div className="stat-value">{resolveResult.token.currentGroups.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Remain Quota</div>
            <div className="stat-value">{resolveResult.token.remainQuota?.toLocaleString() || "-"}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Available Models</div>
            <div className="stat-value">{availableModels.length}</div>
          </div>
        </div>
      ) : null}

      {loadingPricing ? (
        <div className="loading"><div className="loading-spinner" /></div>
      ) : pricing ? (
        <>
          <div className="card" style={{ marginBottom: 24 }}>
            <div className="card-header">
              <div>
                <div className="card-title">Group Selection</div>
                <div className="card-subtitle">Model counts update immediately as you add or remove groups.</div>
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <button className="btn btn-ghost" onClick={() => setSelectedGroups(new Set())}>
                  Clear
                </button>
                <button className="btn btn-primary" onClick={() => void saveGroups()} disabled={saving || !resolveResult}>
                  {saving ? "Saving..." : "Save Groups"}
                </button>
              </div>
            </div>
            <div className="group-chips">
              {(resolveResult?.availableGroups || pricing.groups).map((group) => (
                <button
                  key={group.name}
                  className={`group-chip${selectedGroups.has(group.name) ? " selected" : ""}`}
                  onClick={() => toggleGroup(group.name)}
                >
                  {group.displayName}
                  <span className="model-count">{groupModelCounts[group.name] || 0}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Matching Models</div>
                <div className="card-subtitle">{availableModels.length} model(s) match the selected groups.</div>
              </div>
            </div>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Mode</th>
                    <th>Input / 1M</th>
                    <th>Output / 1M</th>
                    <th>Request</th>
                    <th>Groups</th>
                  </tr>
                </thead>
                <tbody>
                  {availableModels.slice(0, 120).map((model) => (
                    <tr key={model.modelName}>
                      <td>{model.modelName}</td>
                      <td><span className="badge badge-accent">{modeLabel(model.pricingMode)}</span></td>
                      <td>{formatPrice(model.inputPricePer1M)}</td>
                      <td>{formatPrice(model.outputPricePer1M)}</td>
                      <td>{formatPrice(model.requestPrice)}</td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {model.enableGroups.map((group) => (
                            <span key={group} className={`badge ${selectedGroups.has(group) ? "badge-green" : "badge-group"}`}>
                              {group}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
