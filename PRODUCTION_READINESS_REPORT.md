# HealthFlow Production Readiness Report

Date: 2026-06-06

## Cleanup Summary

Archived into `archive-review`:

- `.claude`
- `.vercel`
- `dist`
- Removed credential-bearing archived NHIA Postman PDF after verification.

Left untouched:

- `data/` because it contains SQLite databases that may hold live branch data.
- Removed `.sixth/` as an obsolete local artifact.
- Supabase SQL, migrations, NHIS catalogs, CLAIM-it files, Firebase files, and local branch server files.

## Local Branch Server Readiness Score

Readiness: 86%

The branch server is production-usable for controlled facility deployments, with strong local-first workflow support and service installers. Remaining work is mostly operational hardening and observability.

## Verification Results

- `node --check local-branch-server/src/config.js`: passed
- `node --check local-branch-server/src/server.js`: passed
- `npm run lint`: passed with 31 existing warnings and 0 errors
- `npm run build`: passed
- `npm run build:offline`: passed
- `git diff --check`: passed; Git reported Windows line-ending normalization warnings only

## Verified Strengths

- Windows service installer creates `HealthFlowOfflineServer`.
- Windows service uses automatic startup, NSSM restart policy, log files, and log rotation.
- Linux installer creates a `healthflow-branch` systemd service with restart policy.
- SQLite uses WAL, foreign keys, busy timeout, startup integrity check, and recovery preservation.
- Core APIs exist for inventory, patients, sales, claims, NHIS, NHIA, payments, and sync.
- Protected `/api/*` routes require `x-branch-token`.
- Protected database status and manual backup endpoints are available.
- API and CLAIM-it bridge traffic is covered by a configurable fixed-window rate limiter.
- CLAIM-it bridge can be mounted at `/json-api`.
- Sync outbox tracks pending, failed, syncing, and synced records.
- Facility levels cover pharmacy `P1`, `P2`, `LCS`, `HP` and provider classes `B1`, `B2`, `C`, `D`, `M`, `SM`.
- SMTP/SMS configuration keys are now present in branch server config and env examples.

## Critical Issues

- No critical code blockers were found during the audit.

## Medium Issues

- Linux log retention is left to journald/system administration.
- Backup scheduling is documented but not automated by a bundled scheduler.
- `.sixth/` could not be archived due to Windows access denial.

## Low Priority Improvements

- Add optional built-in backup scheduler for Windows Task Scheduler and Linux cron/systemd timers.
- Add a small communication delivery queue before enabling high-volume SMS/email sending.
- Add structured audit logs for configuration changes.

## Deployment Readiness

- Windows: Ready with documented install, service, logs, firewall, and health check.
- Linux: Ready with documented install, systemd service, permissions, firewall, and native SQLite rebuild notes.
- Cloud sync: Ready when Supabase branch sync client and tokens are correctly configured.
- Offline POS: Ready when `npm run build:offline` has refreshed `local-branch-server/public`.
