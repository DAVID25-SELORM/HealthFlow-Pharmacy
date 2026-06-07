# HealthFlow Deployment Checklist

## Before Handover

- [ ] Confirm facility type: pharmacy, clinic, or hospital.
- [ ] Confirm `ORGANIZATION_ID` and `BRANCH_ID`.
- [ ] Generate a strong `BRANCH_SERVER_TOKEN`.
- [ ] Register `BRANCH_SYNC_TOKEN` in Supabase.
- [ ] Set `NHIA_CONFIG_SECRET_KEY` and keep it unchanged.
- [ ] Confirm NHIA facility code, provider class, claims officer, submitter ID, API key, and API secret.
- [ ] Configure CLAIM-it endpoint paths.
- [ ] Configure payment providers only if used.
- [ ] Configure SMTP/SMS only if client messaging is used.
- [ ] Review `RATE_LIMIT_*` values for the facility LAN size.

## Build

- [ ] `npm install` if dependencies changed.
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run build:offline`
- [ ] `node --check local-branch-server/src/server.js`
- [ ] `node --check local-branch-server/src/config.js`

## Windows

- [ ] Install Node.js 20+.
- [ ] Install service as Administrator.
- [ ] Confirm service `HealthFlowOfflineServer`.
- [ ] Confirm automatic startup.
- [ ] Confirm log rotation.
- [ ] Add private LAN firewall rule for port `4780`.
- [ ] Run health check.

## Linux

- [ ] Install Node.js 20+ and build tools.
- [ ] Install systemd service.
- [ ] Confirm service user permissions.
- [ ] Confirm `/var/lib/healthflow-branch` ownership.
- [ ] Add private LAN firewall rule.
- [ ] Configure journald/logrotate retention.
- [ ] Run health check.

## Data Safety

- [ ] Back up SQLite before import or upgrade.
- [ ] Confirm `PRAGMA integrity_check` returns `ok`.
- [ ] Confirm sync status has no unexpected failed events.
- [ ] Confirm `/api/database/status` returns `ok: true`.
- [ ] Confirm inventory, patients, sales, claims, NHIS claims, and NHIA settings load locally.

## Security

- [ ] No secrets in React `.env`, localStorage, or public tables.
- [ ] Branch token differs per facility.
- [ ] CORS origins reviewed.
- [ ] Public CLAIM-it bridge has `CLAIM_BRIDGE_TOKEN` in production.
- [ ] Payment webhooks have provider secrets where supported.
