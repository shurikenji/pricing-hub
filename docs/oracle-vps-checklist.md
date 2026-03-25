# Oracle VPS Deployment Checklist

This checklist targets `pricing-hub` on a small Oracle VPS with `1 CPU / 1 GB RAM`.

## Runtime

- Use `Node.js 22.x` so the current `node:sqlite` runtime matches local development.
- Run a single app process behind `nginx` or `caddy`.
- Prefer `next start` in production. Do not run `next dev` on the VPS.
- Keep `NODE_ENV=production`.

## Environment

- Set `ADMIN_SECRET` to a long random string.
- Set `APP_ENCRYPTION_KEY` to a stable 32-byte secret and do not rotate it casually.
- Keep `.env.local` readable only by the deploy user.
- Do not log `authToken`, `authCookie`, `authUserValue`, or user-provided API keys.

## Reverse Proxy

- Terminate TLS at `nginx` or `caddy`.
- Forward the real client IP so rate limiting can bucket correctly.
- Enable gzip or brotli for static assets.
- Keep admin on a separate path: `/control`.

## App Process

- Use `systemd` or `pm2` with a single instance.
- Restart on failure, but avoid aggressive restart loops.
- Set a memory ceiling if using `pm2`.

## Storage

- Persist the SQLite data directory on disk and include it in backups.
- Back up:
  - server registry
  - audit logs
  - pricing snapshots
  - sample payload library
- Verify that restore works from the admin backup flow before production cutover.

## Sync Strategy

- Keep public pricing on snapshot-first mode.
- Use an external cron to trigger due jobs:

```bash
curl -X POST https://your-domain.example/api/admin/pricing-snapshots \
  -H 'Content-Type: application/json' \
  -H 'x-admin-secret: YOUR_ADMIN_SECRET' \
  -d '{"runDue":true}'
```

- Start with `autoSyncIntervalMinutes=180` for most servers.
- Reduce interval only for fast-moving upstreams with acceptable rate limits.

## Retention

- Keep pricing snapshots trimmed; current code retains the latest snapshots per server.
- Keep audit logs trimmed; current code retains a bounded recent set.
- Monitor SQLite file growth after the first week of production traffic.

## Monitoring

- Run health checks from `/control` after each deploy.
- Review `Recent Activity`, `Recent Health`, and `Recent Pricing Snapshots` after server changes.
- Watch for repeated `lastSyncErrorCode` or `lastNormalizeError` values in admin.

## Performance

- Avoid frequent full upstream fetches from public traffic.
- Keep image assets minimal; this app is mostly admin/data UI.
- Do not enable multiple Node workers on `1 CPU`.

## Release Verification

- `npm run lint`
- `npm run build`
- `npm test`
- `python .agent/scripts/checklist.py . --skip-performance`
- Confirm `/`, `/logs`, `/keys`, and `/control` load successfully.
- Confirm at least one server can:
  - fetch pricing
  - preview normalizer output
  - sync a snapshot
  - resolve an API key
  - update token groups

## Known Tradeoff

- `node:sqlite` is still marked experimental in Node. It works in the current stack, but if runtime stability becomes a concern, move persistence to `better-sqlite3` or PostgreSQL in a later phase.
