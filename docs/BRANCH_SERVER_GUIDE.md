# HealthFlow Branch Server Guide

This consolidated document preserves the complete contents of the related historical guides.

## Archived source: BRANCH_SERVER_ARCHITECTURE.md

# HealthFlow Branch Server Architecture

## Responsibilities

The branch server is the local backend for facilities that need LAN/offline workflows. It serves:

- Local POS and inventory reads/writes.
- Local patient, claim, purchase, supplier, and sales APIs.
- NHIS/NHIA settings and CLAIM-it workflows.
- CLAIM-it bridge under `/json-api` when enabled.
- SQLite persistence and background Supabase sync.
- Payment webhook and hosted payment initiation routes.
- Facility-wide offline PIN authentication, lockout, and local audit.
- Trusted HTTPS LAN operation and workstation enrollment.

## Runtime Configuration

Configuration is loaded from `local-branch-server/.env` first, then process environment. Important groups:

- Server: `PORT`, `BRANCH_SERVER_TOKEN`, `ALLOWED_ORIGINS`
- Facility: `ORGANIZATION_ID`, `BRANCH_ID`
- Database: `HEALTHFLOW_DB_PATH`, `SQLITE_PATH`
- Sync: `SUPABASE_URL`, `SUPABASE_SYNC_KEY`, `BRANCH_SYNC_TOKEN`
- NHIS/NHIA: `NHIA_CONFIG_SECRET_KEY`, `NHIA_ELIGIBILITY_BASE_URL`, `CLAIMIT_*`, `NHIA_API_*`
- Payments: `PAYSTACK_*`, `HUBTEL_*`, `PAYMENT_*`
- Communication: `COMMUNICATION_*`, `SMTP_*`, `SMS_*`

## Important Endpoints

Public or semi-public:

- `GET /health`
- `GET /branch-runtime-config.js`
- CLAIM-it bridge at `CLAIM_BRIDGE_PUBLIC_PATH`, default `/json-api`
- Payment webhooks: `/api/payments/webhook/hubtel`, `/api/payments/webhook/paystack`

Protected by `x-branch-token`:

- Inventory: `/api/inventory`, `/api/inventory/search`, `/api/inventory/import`, `/api/inventory/:id`
- POS: `/api/pos/bootstrap`, `/api/sales`, `/api/sales/recent`, `/api/sales/:id`
- Patients: `/api/patients`
- Claims: `/api/claims`, `/api/nhis/claims`, `/api/nhia/claims`
- NHIA config and CC generation: `/api/nhia-config`, `/api/nhia/member-lookup`, `/api/nhia/cc-code`
- NHIA batches and export: `/api/nhia/batches`, `/api/nhia/batches/:id/export`
- Sync: `/api/sync/status`, `/api/sync/run`, `/api/sync/repair`, `/api/sync/pull-inventory`, `/api/sync/pull-reference-data`, `/api/sync/diagnostics`
- Database: `/api/database/status`, `/api/database/backup`

## Sync Model

- Local-first writes create rows in SQLite and queue events in `sync_outbox`.
- `supabaseSync.js` pushes sales, claims, NHIA config, and generic offline records.
- Cloud pulls hydrate inventory, patients, suppliers, claims, NHIS drugs, clinical rules, NHIS claims, NHIA configuration, and purchases.
- Failed records remain marked failed and can be repaired through `/api/sync/repair`.

## Sync Modes

- `ONLINE_CLOUD`: frontend talks to Supabase/Edge Functions directly.
- `ONLINE_LOCAL_SYNC`: frontend uses local branch server first; server syncs with Supabase.
- `OFFLINE_LOCAL`: frontend uses local branch server/cache while internet is unavailable.

## Facility Coverage

The code supports pharmacy and hospital/clinic-oriented NHIS workflows, including:

- Pharmacy levels: `P1`, `P2`, `LCS`, `HP`
- Hospital/provider classes: `B1`, `B2`, `C`, `D`, `M`, `SM`
- Multiple branches through `BRANCH_ID` and Supabase branch sync clients
- Multiple claims users through role and `can_manage_claims` permissions
- Multiple submitter IDs through NHIA settings per organization/branch

## Security Model

- Protected local API routes require `x-branch-token`.
- CORS allows localhost, private LAN origins, configured origins, and the production app.
- API and CLAIM-it bridge routes have an in-memory fixed-window rate limiter controlled by `RATE_LIMIT_*` settings.
- NHIA secrets are encrypted using `NHIA_CONFIG_SECRET_KEY`.
- Payment, SMTP, SMS, NHIA, and sync secrets are backend-only.
- Cloud passwords are never stored for offline login. Offline PINs are stored
  only as salted scrypt hashes on the facility server.
- Missing/invalid TLS forces loopback-only access; multi-computer access
  requires a trusted certificate and authorized workstation.

---

## Archived source: WINDOWS_INSTALLATION.md

# HealthFlow Local Branch Server - Windows Installation

## Purpose

The Windows branch server runs the offline POS, local API, SQLite database, NHIS/CLAIM-it bridge, payment webhooks, and background sync worker for a facility machine or LAN server.

## Requirements

- Windows 10/11 or Windows Server.
- Node.js 20 or newer.
- Administrator PowerShell.
- Internet access during installation if dependencies or NSSM must be downloaded.
- A completed `local-branch-server\.env`.

## Install

1. Build the offline frontend bundle from the project root:

   ```powershell
   npm.cmd run build:offline
   ```

2. Edit `local-branch-server\.env` using `local-branch-server\.env.example`.

3. Install as a Windows service:

   ```powershell
   powershell -ExecutionPolicy Bypass -File local-branch-server\scripts\install-windows-service.ps1 -InstallRoot C:\HealthFlowLocal -InstallDependencies
   ```

4. Confirm service health:

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\HealthFlowLocal\local-branch-server\scripts\health-check.ps1 -InstallRoot C:\HealthFlowLocal
   ```

## Service Details

- Service name: `HealthFlowOfflineServer`
- Startup: automatic
- Crash recovery: restart through NSSM and Windows service failure actions
- Logs: `C:\HealthFlowLocal\logs`
- Database: `C:\HealthFlowLocal\data\healthflow-branch.sqlite`
- Browser URL on the server: `http://localhost:4780`
- LAN URL: `http://SERVER_IP:4780`

## Firewall

Allow inbound TCP `4780` only on trusted private LAN networks:

```powershell
New-NetFirewallRule -DisplayName "HealthFlow Branch Server 4780" -Direction Inbound -Protocol TCP -LocalPort 4780 -Action Allow -Profile Private
```

Do not expose port `4780` directly to the public internet.

## Update Process

The **Download and Install** button in Offline Sync downloads the first-time
workstation installer for users who do not already have a local branch server.
Publish only the self-contained package created by:

```powershell
cd local-branch-server
npm run build:offline-installer
```

That package contains the offline browser app, local branch server, production
dependencies, portable Node.js runtime, bundled NSSM service helper, SQLite data
folder setup, Windows service setup, desktop shortcut, TLS provisioning, and
workstation enrollment tools. After the installer runs, **Branch Sync Setup**
registers the machine for cloud sync and the Offline Setup Wizard verifies
readiness. Once the facility has been permitted and synced, supported workflows
can continue offline without internet.

After uploading `HealthFlow-Offline-Installer-<version>.zip` to the approved
HTTPS download location, set production `VITE_HEALTHFLOW_INSTALLER_URL` to that
exact ZIP URL and redeploy the cloud app.

The **Check for Updates** and **Download Update** buttons update an already
installed and connected local branch server/offline app.

Keep token names distinct: `BRANCH_SERVER_TOKEN` protects local branch server
API calls from browsers and scripts; `BRANCH_SYNC_TOKEN` registers the local
server for Supabase sync.

1. Stop the service.
2. Back up `C:\HealthFlowLocal\data\healthflow-branch.sqlite`.
3. Pull/copy the updated app.
4. Run `npm.cmd run build:offline`.
5. Re-run `install-windows-service.ps1` or copy the updated `local-branch-server` files while preserving `.env` and `data`.
6. Start the service and run the health check.

## Communication Setup

Email and SMS settings are backend-only. Configure SMTP/SMS in `local-branch-server\.env` and keep those values out of React, browser storage, and public Supabase tables.

---

## Archived source: LINUX_INSTALLATION.md

# HealthFlow Local Branch Server - Linux Installation

## Purpose

Linux can host the local branch server as a systemd service for a pharmacy, clinic, or hospital LAN.

## Requirements

- Ubuntu/Debian, RHEL/CentOS, or another systemd-based Linux distribution.
- Node.js 20 or newer.
- `python3`, `make`, and `g++` so `better-sqlite3` can compile for Linux.
- A completed `.env` based on `local-branch-server/.env.linux.example`.

Ubuntu/Debian packages:

```bash
sudo apt update
sudo apt install -y nodejs npm python3 make g++ rsync curl
```

## Install

1. Copy the repository or `local-branch-server` folder to the Linux machine.
2. Build the offline frontend bundle before handover:

   ```bash
   npm install
   npm run build:offline
   ```

3. Install the service:

   ```bash
   cd local-branch-server
   sudo bash scripts/install-linux-service.sh
   ```

4. Edit the environment file:

   ```bash
   sudo nano /opt/healthflow/local-branch-server/.env
   ```

5. Start and inspect:

   ```bash
   sudo systemctl start healthflow-branch
   sudo systemctl status healthflow-branch
   bash /opt/healthflow/local-branch-server/scripts/health-check.sh
   ```

## Runtime Paths

- Install directory: `/opt/healthflow/local-branch-server`
- Database directory: `/var/lib/healthflow-branch`
- Database file: `/var/lib/healthflow-branch/healthflow-branch.sqlite`
- Service user: `healthflow`
- Service name: `healthflow-branch`

## Firewall

Allow port `4780` only on the trusted LAN:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 4780 proto tcp
```

Adjust the subnet for the facility network.

## Log Rotation

systemd captures logs in journald. Configure retention with journald or add a logrotate rule if logs are redirected to files. Minimum recommendation:

```bash
journalctl -u healthflow-branch --since today
```

## Update Process

1. Back up `/var/lib/healthflow-branch/healthflow-branch.sqlite`.
2. Copy new code.
3. Run `npm ci --omit=dev` inside `/opt/healthflow/local-branch-server`.
4. Run `npm run rebuild:sqlite`.
5. Restart:

   ```bash
   sudo systemctl restart healthflow-branch
   ```
