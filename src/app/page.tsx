"use client";

import { useEffect, useMemo, useState } from "react";

import { buildCsv, triggerCsvDownload } from "@/lib/csv";
import { getErrorMessage } from "@/lib/error-utils";
import type { GroupPriceSnapshot, NormalizedModel, NormalizedPricing, PricingMode } from "@/lib/types";

interface ServerOption {
  id: string;
  name: string;
  type: string;
  supportsGroupChain: boolean;
  groupSelectionMode?: string;
  groupMatchMode?: string;
  notes?: string;
}

type SortKey = "modelName" | "inputPricePer1M" | "outputPricePer1M" | "requestPrice";
type SortDir = "asc" | "desc";

function modeLabel(mode: PricingMode) {
  if (mode === "request_scaled") return "Request-scaled";
  if (mode === "token") return "Token";
  if (mode === "fixed") return "Fixed";
  return "Unknown";
}

function formatPrice(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 0.001) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function priceRange(values: Array<number | undefined>) {
  const filtered = values.filter((value): value is number => typeof value === "number");
  if (filtered.length === 0) return undefined;
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  return min === max ? formatPrice(min) : `${formatPrice(min)} - ${formatPrice(max)}`;
}

function resolveSnapshots(model: NormalizedModel, selectedGroups: Set<string>): GroupPriceSnapshot[] {
  const allSnapshots = Object.values(model.groupPrices || {});
  if (selectedGroups.size === 0) return allSnapshots;
  return Array.from(selectedGroups)
    .map((group) => model.groupPrices?.[group])
    .filter((snapshot): snapshot is GroupPriceSnapshot => Boolean(snapshot));
}

export default function PricingPage() {
  const initialParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [selectedServer, setSelectedServer] = useState(initialParams.get("server") || "");
  const [pricing, setPricing] = useState<NormalizedPricing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState(initialParams.get("q") || "");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set((initialParams.get("groups") || "").split(",").filter(Boolean)));
  const [sortKey, setSortKey] = useState<SortKey>((initialParams.get("sort") as SortKey) || "modelName");
  const [sortDir, setSortDir] = useState<SortDir>((initialParams.get("dir") as SortDir) || "asc");
  const [showToken, setShowToken] = useState(initialParams.get("token") !== "0");
  const [showRequestScaled, setShowRequestScaled] = useState(initialParams.get("requestScaled") !== "0");
  const [showFixed, setShowFixed] = useState(initialParams.get("fixed") !== "0");
  const [endpointFilter, setEndpointFilter] = useState(initialParams.get("endpoint") || "");
  const [groupCountFilter, setGroupCountFilter] = useState(initialParams.get("groupCount") || "");
  const [selectedModelName, setSelectedModelName] = useState<string | null>(null);
  const [fetchMeta, setFetchMeta] = useState<{ source?: string; snapshotId?: string; ageMs?: string }>({});

  useEffect(() => {
    void fetch("/api/servers")
      .then((response) => response.json())
      .then((data: ServerOption[]) => {
        setServers(data);
        if (data.length > 0) {
          setSelectedServer((current) => current || data[0].id);
        }
      })
      .catch(() => setError("Failed to load servers."));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedServer) params.set("server", selectedServer);
    if (search) params.set("q", search);
    if (selectedGroups.size > 0) params.set("groups", Array.from(selectedGroups).join(","));
    if (sortKey !== "modelName") params.set("sort", sortKey);
    if (sortDir !== "asc") params.set("dir", sortDir);
    if (!showToken) params.set("token", "0");
    if (!showRequestScaled) params.set("requestScaled", "0");
    if (!showFixed) params.set("fixed", "0");
    if (endpointFilter) params.set("endpoint", endpointFilter);
    if (groupCountFilter) params.set("groupCount", groupCountFilter);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, [endpointFilter, groupCountFilter, search, selectedGroups, selectedServer, showFixed, showRequestScaled, showToken, sortDir, sortKey]);

  useEffect(() => {
    if (!selectedServer) return;
    setLoading(true);
    setError("");
    void fetch(`/api/pricing?server=${selectedServer}`)
      .then(async (response) => {
        if (!response.ok) {
          throw await response.json().catch(() => null);
        }
        setFetchMeta({
          source: response.headers.get("x-pricing-source") || undefined,
          snapshotId: response.headers.get("x-pricing-snapshot-id") || undefined,
          ageMs: response.headers.get("x-pricing-age-ms") || undefined,
        });
        return response.json();
      })
      .then((data: NormalizedPricing) => {
        setPricing(data);
        setSelectedModelName(data.models[0]?.modelName || null);
      })
      .catch((payload) => setError(getErrorMessage(payload, "Failed to fetch pricing data.")))
      .finally(() => setLoading(false));
  }, [selectedServer]);

  const currentServer = servers.find((server) => server.id === selectedServer);

  function toggleGroup(groupName: string) {
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        if (!currentServer?.supportsGroupChain) {
          next.clear();
        }
        next.add(groupName);
      }
      return next;
    });
  }

  const groupModelCounts = useMemo(() => {
    if (!pricing) return {} as Record<string, number>;
    return Object.fromEntries(
      pricing.groups.map((group) => [
        group.name,
        pricing.models.filter((model) => model.enableGroups.includes(group.name)).length,
      ]),
    );
  }, [pricing]);

  const filteredModels = useMemo(() => {
    if (!pricing) return [] as NormalizedModel[];
    const filtered = pricing.models.filter((model) => {
      if (!showToken && model.pricingMode === "token") return false;
      if (!showRequestScaled && model.pricingMode === "request_scaled") return false;
      if (!showFixed && model.pricingMode === "fixed") return false;
      if (selectedGroups.size > 0 && !model.enableGroups.some((group) => selectedGroups.has(group))) return false;
      if (search && !model.modelName.toLowerCase().includes(search.toLowerCase())) return false;
      if (endpointFilter && !model.supportedEndpoints.includes(endpointFilter)) return false;
      if (groupCountFilter && model.enableGroups.length < Number(groupCountFilter)) return false;
      return true;
    });

    filtered.sort((left, right) => {
      const leftSnapshots = resolveSnapshots(left, selectedGroups);
      const rightSnapshots = resolveSnapshots(right, selectedGroups);
      const leftRequest = leftSnapshots[0]?.requestPrice ?? left.requestPrice ?? 0;
      const rightRequest = rightSnapshots[0]?.requestPrice ?? right.requestPrice ?? 0;
      const leftInput = leftSnapshots[0]?.inputPricePer1M ?? left.inputPricePer1M ?? 0;
      const rightInput = rightSnapshots[0]?.inputPricePer1M ?? right.inputPricePer1M ?? 0;
      const leftOutput = leftSnapshots[0]?.outputPricePer1M ?? left.outputPricePer1M ?? 0;
      const rightOutput = rightSnapshots[0]?.outputPricePer1M ?? right.outputPricePer1M ?? 0;

      let delta = 0;
      if (sortKey === "modelName") delta = left.modelName.localeCompare(right.modelName);
      if (sortKey === "inputPricePer1M") delta = leftInput - rightInput;
      if (sortKey === "outputPricePer1M") delta = leftOutput - rightOutput;
      if (sortKey === "requestPrice") delta = leftRequest - rightRequest;
      return sortDir === "asc" ? delta : -delta;
    });

    return filtered;
  }, [endpointFilter, groupCountFilter, pricing, search, selectedGroups, showFixed, showRequestScaled, showToken, sortDir, sortKey]);

  const selectedModel = filteredModels.find((model) => model.modelName === selectedModelName) || filteredModels[0] || null;
  const endpointOptions = useMemo(
    () => Array.from(new Set(pricing?.models.flatMap((model) => model.supportedEndpoints) || [])).sort((left, right) => left.localeCompare(right)),
    [pricing],
  );

  function toggleSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDir("asc");
  }

  function exportCsv() {
    const csv = buildCsv(
      ["model", "mode", "input_per_1m", "output_per_1m", "request_price", "groups", "endpoints"],
      filteredModels.map((model) => [
        model.modelName,
        model.pricingMode,
        model.inputPricePer1M,
        model.outputPricePer1M,
        model.requestPrice,
        model.enableGroups.join("|"),
        model.supportedEndpoints.join("|"),
      ]),
    );
    triggerCsvDownload(`pricing-${selectedServer || "server"}.csv`, csv);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Model Pricing</h1>
        <p className="page-description">
          Unified pricing view across multiple upstream servers, including group-aware token pricing and request-scaled models.
        </p>
      </div>

      {pricing ? (
        <div className="stats-row">
          <div className="stat-card">
            <div className="stat-label">Models</div>
            <div className="stat-value">{pricing.models.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Visible</div>
            <div className="stat-value">{filteredModels.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Groups</div>
            <div className="stat-value">{pricing.groups.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Selection Mode</div>
            <div className="stat-value">{currentServer?.supportsGroupChain ? "Chain" : "Single"}</div>
          </div>
        </div>
      ) : null}

      <div className="controls-bar">
        <select value={selectedServer} onChange={(event) => setSelectedServer(event.target.value)}>
          {servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
        <input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search model name" />
        <select value={endpointFilter} onChange={(event) => setEndpointFilter(event.target.value)}>
          <option value="">All endpoints</option>
          {endpointOptions.map((endpoint) => (
            <option key={endpoint} value={endpoint}>
              {endpoint}
            </option>
          ))}
        </select>
        <input value={groupCountFilter} onChange={(event) => setGroupCountFilter(event.target.value)} placeholder="Min group count" inputMode="numeric" />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showToken} onChange={(event) => setShowToken(event.target.checked)} /> Token
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showRequestScaled} onChange={(event) => setShowRequestScaled(event.target.checked)} /> Request-scaled
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showFixed} onChange={(event) => setShowFixed(event.target.checked)} /> Fixed
        </label>
        <button className="btn btn-ghost" onClick={exportCsv} disabled={!pricing}>
          Export CSV
        </button>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>How Pricing Works</div>
        <div className="card-subtitle">
          `request_scaled` means the server charges on request-equivalent quota, while `token` mode follows normalized token math. Use group filters to compare the same model across single-group and chain-capable servers.
        </div>
      </div>

      {currentServer?.notes ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-subtitle">{currentServer.notes}</div>
        </div>
      ) : null}

      {pricing ? (
        <div className="card" style={{ marginBottom: 20, padding: 16 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Group Filter</div>
              <div className="card-subtitle">Selected: {selectedGroups.size}</div>
            </div>
            <button className="btn btn-ghost" onClick={() => setSelectedGroups(new Set())}>
              Clear
            </button>
          </div>
          <div className="group-chips">
            {pricing.groups.map((group) => (
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
      ) : null}

      {loading ? <div className="loading"><div className="loading-spinner" /></div> : null}
      {error ? <div className="empty-state"><div className="empty-icon">!</div><p>{error}</p></div> : null}

      {!loading && pricing ? (
        <>
          <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th onClick={() => toggleSort("modelName")}>Model</th>
                <th>Mode</th>
                <th onClick={() => toggleSort("inputPricePer1M")}>Input / 1M</th>
                <th onClick={() => toggleSort("outputPricePer1M")}>Output / 1M</th>
                <th>Cache / 1M</th>
                <th onClick={() => toggleSort("requestPrice")}>Request</th>
                <th>Groups</th>
                <th>Endpoints</th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: "center", padding: 36 }}>
                    No model matches the current filters.
                  </td>
                </tr>
              ) : filteredModels.map((model) => {
                const snapshots = resolveSnapshots(model, selectedGroups);
                return (
                  <tr key={model.modelName} onClick={() => setSelectedModelName(model.modelName)} style={{ cursor: "pointer" }}>
                    <td>{model.modelName}</td>
                    <td><span className="badge badge-accent">{modeLabel(model.pricingMode)}</span></td>
                    <td>{priceRange(snapshots.length ? snapshots.map((snapshot) => snapshot.inputPricePer1M) : [model.inputPricePer1M])}</td>
                    <td>{priceRange(snapshots.length ? snapshots.map((snapshot) => snapshot.outputPricePer1M) : [model.outputPricePer1M])}</td>
                    <td>{priceRange(snapshots.length ? snapshots.map((snapshot) => snapshot.cachedInputPricePer1M) : [model.cachedInputPricePer1M])}</td>
                    <td>{priceRange(snapshots.length ? snapshots.map((snapshot) => snapshot.requestPrice) : [model.requestPrice])}</td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {model.enableGroups.slice(0, 4).map((group) => (
                          <span key={group} className={`badge ${selectedGroups.has(group) ? "badge-green" : "badge-group"}`}>
                            {group}
                          </span>
                        ))}
                        {model.enableGroups.length > 4 ? <span className="badge badge-group">+{model.enableGroups.length - 4}</span> : null}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {model.supportedEndpoints.map((endpoint) => (
                          <span key={endpoint} className="badge badge-cyan">
                            {endpoint}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div className="lab-panel" style={{ marginTop: 16 }}>
            <div className="card-title" style={{ marginBottom: 10 }}>Pricing Drilldown</div>
            {!selectedModel ? (
              <div className="card-subtitle">Select a model row to inspect ratios, group snapshots, and current snapshot metadata.</div>
            ) : (
              <div className="lab-stack">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge badge-cyan">{selectedModel.modelName}</span>
                  <span className="badge badge-group">{modeLabel(selectedModel.pricingMode)}</span>
                  {fetchMeta.snapshotId ? <span className="badge badge-group">snapshot #{fetchMeta.snapshotId}</span> : null}
                  {fetchMeta.source ? <span className="badge badge-group">{fetchMeta.source}</span> : null}
                </div>
                <div className="stats-row" style={{ marginBottom: 0 }}>
                  <div className="stat-card">
                    <div className="stat-label">Model Ratio</div>
                    <div className="stat-value">{selectedModel.modelRatio}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Completion Ratio</div>
                    <div className="stat-value">{selectedModel.completionRatio}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Cache Ratio</div>
                    <div className="stat-value">{selectedModel.cacheRatio ?? "-"}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Model Price</div>
                    <div className="stat-value">{formatPrice(selectedModel.modelPrice)}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {Object.values(selectedModel.groupPrices || {}).map((group) => (
                    <span key={group.groupName} className="badge badge-group">
                      {group.groupName}: {formatPrice(group.inputPricePer1M || group.requestPrice)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      ) : null}

      {pricing ? (
        <div style={{ marginTop: 16, color: "var(--text-secondary)", fontSize: 12, textAlign: "right" }}>
          Snapshot: {new Date(pricing.fetchedAt).toLocaleString()} · Server: {pricing.serverName}
        </div>
      ) : null}
    </>
  );
}
