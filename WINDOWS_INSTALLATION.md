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

1. Stop the service.
2. Back up `C:\HealthFlowLocal\data\healthflow-branch.sqlite`.
3. Pull/copy the updated app.
4. Run `npm.cmd run build:offline`.
5. Re-run `install-windows-service.ps1` or copy the updated `local-branch-server` files while preserving `.env` and `data`.
6. Start the service and run the health check.

## Communication Setup

Email and SMS settings are backend-only. Configure SMTP/SMS in `local-branch-server\.env` and keep those values out of React, browser storage, and public Supabase tables.
