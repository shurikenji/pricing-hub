"use client";

import { useEffect, useMemo, useState } from "react";

import { getErrorMessage } from "@/lib/error-utils";
import { getServerCapability } from "@/lib/server-capabilities";
import type {
  GroupPriceSnapshot,
  PricingSnapshotRecord,
  ServerConfig,
  ServerHealthHistoryEntry,
  ServerSamplePayload,
  SamplePayloadType,
} from "@/lib/types";

type WorkbenchTab = "overview" | "samples" | "normalizer" | "sync";

interface ServerWorkbenchProps {
  servers: ServerConfig[];
  onLoadSampleToLab: (sample: ServerSamplePayload) => void;
  onLoadHintsToLab: (server: ServerConfig) => void;
  onMessage: (message: string) => void;
}

const emptySample = {
  id: "",
  sampleType: "pricing" as SamplePayloadType,
  label: "",
  notes: "",
  payloadJson: "{\n  \n}",
};

function toSampleDraft(sample: ServerSamplePayload) {
  return {
    id: sample.id,
    sampleType: sample.sampleType,
    label: sample.label,
    notes: sample.notes || "",
    payloadJson: sample.payloadJson,
  };
}

function formatPrice(value: number | undefined) {
  if (value === undefined) return "-";
  if (value < 0.001) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTime(value: number | undefined) {
  return value ? new Date(value).toLocaleString() : "-";
}

function findModel(snapshot: PricingSnapshotRecord | null, modelName: string | null) {
  if (!snapshot || !modelName) {
    return null;
  }
  return snapshot.pricing.models.find((model) => model.modelName === modelName) || null;
}

export function ServerWorkbench({ servers, onLoadSampleToLab, onLoadHintsToLab, onMessage }: ServerWorkbenchProps) {
  const [selectedServerId, setSelectedServerId] = useState("");
  const [tab, setTab] = useState<WorkbenchTab>("overview");
  const [samples, setSamples] = useState<ServerSamplePayload[]>([]);
  const [sampleDraft, setSampleDraft] = useState(emptySample);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [healthHistory, setHealthHistory] = useState<ServerHealthHistoryEntry[]>([]);
  const [snapshotRecords, setSnapshotRecords] = useState<PricingSnapshotRecord[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
  const [selectedModelName, setSelectedModelName] = useState<string | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncPreview, setSyncPreview] = useState<Record<string, unknown> | null>(null);
  const [workbenchError, setWorkbenchError] = useState("");

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) || servers[0] || null,
    [selectedServerId, servers],
  );
  const selectedSnapshot = useMemo(
    () => snapshotRecords.find((snapshot) => snapshot.id === selectedSnapshotId) || snapshotRecords[0] || null,
    [selectedSnapshotId, snapshotRecords],
  );
  const selectedModel = useMemo(() => findModel(selectedSnapshot, selectedModelName), [selectedModelName, selectedSnapshot]);

  useEffect(() => {
    if (selectedServerId || servers.length === 0) {
      return;
    }
    setSelectedServerId(servers[0].id);
  }, [selectedServerId, servers]);

  useEffect(() => {
    const serverId = selectedServer?.id;
    if (!serverId) {
      return;
    }
    setSampleDraft((current) => ({ ...current, id: "", label: "", notes: "", sampleType: "pricing" }));
    setSelectedModelName(null);
    setSyncPreview(null);
    void Promise.all([fetchSamples(serverId), fetchHealthHistory(serverId), fetchSnapshotRecords(serverId)]);
  }, [selectedServer]);

  useEffect(() => {
    if (!selectedSnapshot) {
      return;
    }
    if (!selectedModelName) {
      setSelectedModelName(selectedSnapshot.pricing.models[0]?.modelName || null);
    }
  }, [selectedModelName, selectedSnapshot]);

  async function fetchSamples(serverId: string) {
    setLoadingSamples(true);
    setWorkbenchError("");
    const response = await fetch(`/api/admin/samples?serverId=${encodeURIComponent(serverId)}`, { credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setWorkbenchError(getErrorMessage(payload, "Failed to load samples."));
      setLoadingSamples(false);
      return;
    }
    setSamples(payload as ServerSamplePayload[]);
    setLoadingSamples(false);
  }

  async function fetchHealthHistory(serverId: string) {
    const response = await fetch(`/api/admin/health?history=1&serverId=${encodeURIComponent(serverId)}`, { credentials: "include" });
    const payload = await response.json().catch(() => []);
    if (response.ok) {
      setHealthHistory(payload as ServerHealthHistoryEntry[]);
    }
  }

  async function fetchSnapshotRecords(serverId: string) {
    const response = await fetch(`/api/admin/pricing-snapshots?records=1&server=${encodeURIComponent(serverId)}&limit=8`, {
      credentials: "include",
    });
    const payload = await response.json().catch(() => []);
    if (response.ok) {
      const records = payload as PricingSnapshotRecord[];
      setSnapshotRecords(records);
      setSelectedSnapshotId(records[0]?.id || null);
      setSelectedModelName(records[0]?.pricing.models[0]?.modelName || null);
    }
  }

  async function handleSaveSample() {
    if (!selectedServer) {
      return;
    }

    setWorkbenchError("");
    const response = await fetch("/api/admin/samples", {
      method: sampleDraft.id ? "PUT" : "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sampleDraft.id || undefined,
        serverId: selectedServer.id,
        sampleType: sampleDraft.sampleType,
        label: sampleDraft.label,
        notes: sampleDraft.notes,
        payloadJson: sampleDraft.payloadJson,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setWorkbenchError(getErrorMessage(payload, "Failed to save sample."));
      return;
    }

    onMessage(`Saved ${sampleDraft.sampleType} sample for ${selectedServer.name}.`);
    setSampleDraft(emptySample);
    await fetchSamples(selectedServer.id);
  }

  async function handleCloneSample(sampleId: string) {
    const response = await fetch("/api/admin/samples", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cloneFromId: sampleId }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setWorkbenchError(getErrorMessage(payload, "Failed to clone sample."));
      return;
    }
    onMessage("Sample cloned.");
    if (selectedServer) {
      await fetchSamples(selectedServer.id);
    }
  }

  async function handleDeleteSample(sampleId: string) {
    const response = await fetch(`/api/admin/samples?id=${encodeURIComponent(sampleId)}`, {
      method: "DELETE",
      credentials: "include",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setWorkbenchError(getErrorMessage(payload, "Failed to delete sample."));
      return;
    }
    onMessage("Sample deleted.");
    if (selectedServer) {
      await fetchSamples(selectedServer.id);
    }
  }

  async function handleDryRunSync() {
    if (!selectedServer) {
      return;
    }
    setSyncLoading(true);
    setWorkbenchError("");

    const response = await fetch("/api/admin/pricing-snapshots", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: selectedServer.id, dryRun: true }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setWorkbenchError(getErrorMessage(payload, "Dry run failed."));
      setSyncLoading(false);
      return;
    }

    setSyncPreview(payload as Record<string, unknown>);
    setSyncLoading(false);
    onMessage(`Dry-run sync completed for ${selectedServer.name}.`);
  }

  function renderGroupPrices(groupPrices: Record<string, GroupPriceSnapshot> | undefined) {
    if (!groupPrices || Object.keys(groupPrices).length === 0) {
      return <div className="card-subtitle">No group-specific pricing snapshot available.</div>;
    }

    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {Object.values(groupPrices).map((group) => (
          <span key={group.groupName} className="badge badge-group">
            {group.groupName}: {formatPrice(group.inputPricePer1M || group.requestPrice)}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="card-title">Server Workbench</div>
          <div className="card-subtitle">Overview, samples, normalizer shortcuts, and sync history for one upstream server.</div>
        </div>
        <div style={{ minWidth: 260 }}>
          <label className="form-label">Server</label>
          <select value={selectedServer?.id || ""} onChange={(event) => setSelectedServerId(event.target.value)}>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        {(["overview", "samples", "normalizer", "sync"] as WorkbenchTab[]).map((item) => (
          <button
            key={item}
            className={`btn ${tab === item ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab(item)}
          >
            {item === "sync" ? "Sync History" : item.charAt(0).toUpperCase() + item.slice(1)}
          </button>
        ))}
      </div>

      {workbenchError ? (
        <div className="card-subtitle" style={{ color: "var(--red)", marginBottom: 14 }}>
          {workbenchError}
        </div>
      ) : null}

      {selectedServer && tab === "overview" ? (
        <div className="lab-result-grid">
          <div className="lab-panel">
            <div className="card-title" style={{ marginBottom: 10 }}>Capabilities</div>
            {(() => {
              const capability = getServerCapability(selectedServer);
              return (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge badge-cyan">{capability.groupSelectionMode}</span>
                  <span className="badge badge-group">{capability.groupMatchMode}</span>
                  <span className="badge badge-group">{capability.tokenUpdateMode}</span>
                  <span className="badge badge-group">{capability.logResolveMode}</span>
                </div>
              );
            })()}
            <div className="stats-row" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="stat-card">
                <div className="stat-label">Last Sync</div>
                <div className="stat-note">{formatTime(selectedServer.lastPricingSyncAt)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Last Parse</div>
                <div className="stat-note">
                  {selectedServer.lastSyncModelCount || 0} models / {selectedServer.lastSyncGroupCount || 0} groups
                </div>
              </div>
            </div>
          </div>

          <div className="lab-panel">
            <div className="card-title" style={{ marginBottom: 10 }}>Recent Health</div>
            <div style={{ display: "grid", gap: 10 }}>
              {healthHistory.length === 0 ? (
                <div className="card-subtitle">No health history yet.</div>
              ) : (
                healthHistory.slice(0, 8).map((entry) => (
                  <div key={entry.id} style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <span className={`badge ${entry.status === "healthy" ? "badge-green" : entry.status === "degraded" ? "badge-amber" : "badge-red"}`}>
                        {entry.status}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{entry.latencyMs} ms</span>
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>{formatTime(entry.checkedAt)}</div>
                    <div style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 4 }}>{entry.message}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {selectedServer && tab === "samples" ? (
        <div className="lab-result-grid">
          <div className="lab-panel">
            <div className="card-title" style={{ marginBottom: 10 }}>Sample Library</div>
            {loadingSamples ? (
              <div className="card-subtitle">Loading samples...</div>
            ) : samples.length === 0 ? (
              <div className="card-subtitle">No samples saved for this server yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {samples.map((sample) => (
                  <div key={sample.id} style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{sample.label}</div>
                        <div className="card-subtitle">{sample.sampleType} · v{sample.version}</div>
                      </div>
                      <span className="badge badge-group">{formatTime(sample.updatedAt)}</span>
                    </div>
                    {sample.notes ? <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 10 }}>{sample.notes}</div> : null}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="btn btn-ghost" onClick={() => setSampleDraft(toSampleDraft(sample))}>
                        Edit
                      </button>
                      <button className="btn btn-ghost" onClick={() => onLoadSampleToLab(sample)}>
                        Load To Lab
                      </button>
                      <button className="btn btn-ghost" onClick={() => void handleCloneSample(sample.id)}>
                        Clone
                      </button>
                      <button className="btn btn-danger" onClick={() => void handleDeleteSample(sample.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lab-panel">
            <div className="card-title" style={{ marginBottom: 10 }}>{sampleDraft.id ? "Edit Sample" : "New Sample"}</div>
            <div className="form-group">
              <label className="form-label">Type</label>
              <select
                value={sampleDraft.sampleType}
                onChange={(event) => setSampleDraft((current) => ({ ...current, sampleType: event.target.value as SamplePayloadType }))}
              >
                <option value="pricing">pricing</option>
                <option value="logs">logs</option>
                <option value="token">token</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Label</label>
              <input value={sampleDraft.label} onChange={(event) => setSampleDraft((current) => ({ ...current, label: event.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea value={sampleDraft.notes} onChange={(event) => setSampleDraft((current) => ({ ...current, notes: event.target.value }))} rows={3} />
            </div>
            <div className="form-group">
              <label className="form-label">Payload JSON</label>
              <textarea className="lab-code" value={sampleDraft.payloadJson} onChange={(event) => setSampleDraft((current) => ({ ...current, payloadJson: event.target.value }))} rows={14} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={() => void handleSaveSample()}>
                {sampleDraft.id ? "Update Sample" : "Create Sample"}
              </button>
              <button className="btn btn-ghost" onClick={() => setSampleDraft(emptySample)}>
                Reset
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedServer && tab === "normalizer" ? (
        <div className="lab-result-grid">
          <div className="lab-panel">
            <div className="card-title" style={{ marginBottom: 10 }}>Hints Shortcut</div>
            <div className="card-subtitle" style={{ marginBottom: 12 }}>
              Load this server&apos;s normalizer hints directly into the main Normalizer Lab below, then run preview with your selected sample.
            </div>
            <button className="btn btn-primary" onClick={() => onLoadHintsToLab(selectedServer)}>
              Load Server Hints To Lab
            </button>
          </div>

          <div className="lab-panel">
            <div className="card-title" style={{ marginBottom: 10 }}>Sample Shortcuts</div>
            {samples.length === 0 ? (
              <div className="card-subtitle">Create a sample in the Samples tab first.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {samples.slice(0, 6).map((sample) => (
                  <div key={sample.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{sample.label}</div>
                      <div className="card-subtitle">{sample.sampleType}</div>
                    </div>
                    <button className="btn btn-ghost" onClick={() => onLoadSampleToLab(sample)}>
                      Use In Lab
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {selectedServer && tab === "sync" ? (
        <div className="lab-stack">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={() => void handleDryRunSync()} disabled={syncLoading}>
              {syncLoading ? "Running..." : "Dry Run Sync"}
            </button>
            <button className="btn btn-ghost" onClick={() => void fetchSnapshotRecords(selectedServer.id)}>
              Refresh Snapshot History
            </button>
          </div>

          {syncPreview ? (
            <div className="lab-panel">
              <div className="card-title" style={{ marginBottom: 8 }}>Dry Run Result</div>
              <pre className="lab-code" style={{ margin: 0 }}>{JSON.stringify(syncPreview, null, 2)}</pre>
            </div>
          ) : null}

          <div className="lab-result-grid">
            <div className="lab-panel">
              <div className="card-title" style={{ marginBottom: 10 }}>Snapshot History</div>
              {snapshotRecords.length === 0 ? (
                <div className="card-subtitle">No snapshot history yet.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {snapshotRecords.map((snapshot) => (
                    <button
                      key={snapshot.id}
                      className={`group-chip${selectedSnapshot?.id === snapshot.id ? " selected" : ""}`}
                      onClick={() => {
                        setSelectedSnapshotId(snapshot.id);
                        setSelectedModelName(snapshot.pricing.models[0]?.modelName || null);
                      }}
                    >
                      #{snapshot.id} · {formatTime(snapshot.fetchedAt)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lab-panel">
              <div className="card-title" style={{ marginBottom: 10 }}>Models In Snapshot</div>
              {!selectedSnapshot ? (
                <div className="card-subtitle">Select a snapshot to inspect.</div>
              ) : (
                <div style={{ display: "grid", gap: 8, maxHeight: 340, overflow: "auto" }}>
                  {selectedSnapshot.pricing.models.slice(0, 80).map((model) => (
                    <button
                      key={model.modelName}
                      className={`group-chip${selectedModelName === model.modelName ? " selected" : ""}`}
                      onClick={() => setSelectedModelName(model.modelName)}
                    >
                      {model.modelName}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lab-panel">
              <div className="card-title" style={{ marginBottom: 10 }}>Pricing Drilldown</div>
              {!selectedSnapshot || !selectedModel ? (
                <div className="card-subtitle">Select a model from snapshot history to inspect ratios and group prices.</div>
              ) : (
                <div className="lab-stack">
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span className="badge badge-cyan">snapshot #{selectedSnapshot.id}</span>
                    <span className="badge badge-group">{selectedModel.pricingMode}</span>
                    <span className="badge badge-group">quota_type {selectedModel.quotaType}</span>
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
                      <div className="stat-label">Request Price</div>
                      <div className="stat-value">{formatPrice(selectedModel.requestPrice)}</div>
                    </div>
                  </div>
                  {renderGroupPrices(selectedModel.groupPrices)}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
