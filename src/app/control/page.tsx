"use client";

import { useCallback, useEffect, useState } from "react";

import type { AdminAuditLog, AuthMode, PricingSnapshotSummary, ServerConfig, ServerType } from "@/lib/types";

const emptyServer: ServerConfig = {
  id: "",
  name: "",
  baseUrl: "",
  type: "newapi",
  supportsGroupChain: false,
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
  groupsPath: "/api/user/self/groups",
  notes: "",
};

export default function ControlPage() {
  const [loginSecret, setLoginSecret] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editServer, setEditServer] = useState<ServerConfig>(emptyServer);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [pricingSnapshots, setPricingSnapshots] = useState<PricingSnapshotSummary[]>([]);
  const [message, setMessage] = useState("");

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
      await fetchAuditLogs();
      await fetchPricingSnapshots();
    } catch {
      setMessage("Failed to load server configuration.");
    } finally {
      setLoading(false);
    }
  }, [fetchAuditLogs, fetchPricingSnapshots]);

  useEffect(() => {
    void fetch("/api/admin/session", { credentials: "include" })
      .then((response) => response.json())
      .then((payload: { authenticated?: boolean }) => {
        if (payload.authenticated) {
          void fetchServers();
        }
      });
  }, [fetchServers]);

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
  }

  function updateField<K extends keyof ServerConfig>(key: K, value: ServerConfig[K]) {
    setEditServer((current) => ({ ...current, [key]: value }));
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
        <button className="btn btn-ghost" onClick={() => void handleLogout()}>
          Logout
        </button>
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
                <th>Type</th>
                <th>Base URL</th>
                <th>Auth</th>
                <th>Group Mode</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr key={server.id}>
                  <td>{server.id}</td>
                  <td>{server.name}</td>
                  <td>{server.type}</td>
                  <td>{server.baseUrl}</td>
                  <td>{server.authMode || "header"}</td>
                  <td>{server.supportsGroupChain ? "Chain" : "Single"}</td>
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
                <label className="form-label">Auth Mode</label>
                <select value={editServer.authMode || "header"} onChange={(event) => updateField("authMode", event.target.value as AuthMode)}>
                  <option value="header">header</option>
                  <option value="bearer">bearer</option>
                  <option value="cookie">cookie</option>
                  <option value="none">none</option>
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
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Groups Path</label>
                <input value={editServer.groupsPath || ""} onChange={(event) => updateField("groupsPath", event.target.value)} />
              </div>
              <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                <label className="form-label">Notes</label>
                <textarea value={editServer.notes || ""} onChange={(event) => updateField("notes", event.target.value)} rows={4} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
              <label>
                <input type="checkbox" checked={editServer.supportsGroupChain} onChange={(event) => updateField("supportsGroupChain", event.target.checked)} /> Group chain
              </label>
              <label>
                <input type="checkbox" checked={editServer.ratioConfigEnabled} onChange={(event) => updateField("ratioConfigEnabled", event.target.checked)} /> Ratio config
              </label>
              <label>
                <input type="checkbox" checked={editServer.enabled} onChange={(event) => updateField("enabled", event.target.checked)} /> Enabled
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
