"""Database DDL — all tables for pricing-hub."""

CREATE_TABLES = """
-- SERVERS (upstream API servers to aggregate pricing from)
CREATE TABLE IF NOT EXISTS servers (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    base_url            TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'newapi',
    enabled             INTEGER DEFAULT 1,
    sort_order          INTEGER DEFAULT 0,
    quota_multiple      REAL DEFAULT 1.0,

    -- Feature flags
    supports_group_chain INTEGER DEFAULT 0,
    ratio_config_enabled INTEGER DEFAULT 0,

    -- Auth
    auth_mode           TEXT DEFAULT 'header',
    auth_user_header    TEXT,
    auth_user_value     TEXT,
    auth_token          TEXT,
    auth_cookie         TEXT,

    -- Custom paths
    pricing_path        TEXT DEFAULT '/api/pricing',
    ratio_config_path   TEXT DEFAULT '/api/ratio_config',
    log_path            TEXT DEFAULT '/api/log/self',
    token_search_path   TEXT DEFAULT '/api/token/search',
    groups_path         TEXT,
    manual_groups       TEXT,

    -- Internal
    notes               TEXT,

    -- Cache
    pricing_cache       TEXT,
    pricing_fetched_at  TEXT,
    groups_cache        TEXT,
    groups_fetched_at   TEXT,

    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now'))
);

-- TRANSLATION CACHE (AI-translated group labels)
CREATE TABLE IF NOT EXISTS translation_cache (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name   TEXT NOT NULL,
    server_type     TEXT NOT NULL DEFAULT 'newapi',
    name_en         TEXT,
    desc_en         TEXT,
    category        TEXT DEFAULT 'Other',
    updated_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(original_name, server_type)
);

-- SYNC LOG (poller audit)
CREATE TABLE IF NOT EXISTS sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    model_count     INTEGER DEFAULT 0,
    group_count     INTEGER DEFAULT 0,
    duration_ms     INTEGER DEFAULT 0,
    error_message   TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sync_log_server ON sync_log(server_id, created_at);

-- APP SETTINGS (runtime admin configuration)
CREATE TABLE IF NOT EXISTS app_settings (
    key             TEXT PRIMARY KEY,
    value           TEXT,
    updated_at      TEXT DEFAULT (datetime('now'))
);
"""
