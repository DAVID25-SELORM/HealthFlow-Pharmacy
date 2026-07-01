# HealthFlow Troubleshooting

## NHIS direct serving asks for MCA or stock

Confirm migrations through
`20260701140000_bypass_mca_for_direct_nhis_serving.sql` are applied and refresh
the deployed app. **Serve Directly** must mark the entered quantities served,
bypass MCA, and leave inventory unchanged. **Send to Dispensary** is the action
that creates MCA work.

## Browser displays “Free up space to continue”

This warning comes from browser/device storage pressure, not the HealthFlow
server. Free disk space and clear unused site data carefully. Do not remove
HealthFlow local data during an unsynchronized offline session.

## TLS Not Configured

Multi-computer offline access requires a trusted certificate at the configured
paths. The Windows defaults are:

```text
C:\HealthFlowLocal\certs\server.crt
C:\HealthFlowLocal\certs\server.key
```

Without both valid files, local-only fallback is intentional.

## Branch Server Not Opening

Check:

- Service is running.
- `PORT=4780` in `.env`.
- Firewall allows port `4780` on the LAN.
- Browser uses the server IP, not `localhost`, from other machines.

Windows:

```powershell
Get-Service HealthFlowOfflineServer
powershell -ExecutionPolicy Bypass -File C:\HealthFlowLocal\local-branch-server\scripts\health-check.ps1
```

Linux:

```bash
sudo systemctl status healthflow-branch
bash /opt/healthflow/local-branch-server/scripts/health-check.sh
```

## 401 From Local API

The browser is missing or using the wrong `x-branch-token`. Confirm `BRANCH_SERVER_TOKEN` in the branch server `.env` matches the browser setting.

## NHIA Secret Cannot Decrypt

Cause: `NHIA_CONFIG_SECRET_KEY` does not match the key used when credentials were saved, or the saved facility credentials were created before the permanent production key was configured.

Fix:

1. Confirm Supabase Edge Functions and each local branch server use the same permanent `NHIA_CONFIG_SECRET_KEY`.
2. Do not replace that key during new facility onboarding.
3. Re-enter and save the facility's NHIA API key/secret in Settings if a specific facility still cannot decrypt.
4. Test member lookup or CC code generation.

## CLAIM-it CC Code Fails

Check:

- `CLAIMIT_UPSTREAM_BASE_URL`
- `CLAIMIT_UPSTREAM_MEMBER_LOOKUP_PATH=/api/hmis/genCCC`
- `CLAIMIT_UPSTREAM_API_KEY_HEADER=x-nhia-apikey`
- `CLAIMIT_UPSTREAM_API_SECRET_HEADER=x-nhia-apisecret`
- Actual facility API key and secret, preserving case and special characters exactly.

## Local CLAIM-it URL From Hosted App

`localhost` always means the current computer. A hosted Vercel app cannot call a CLAIM-it process running on another machine through `localhost`; use the branch server LAN IP or a secured bridge.

## Sync Queue Stuck

Open:

- `GET /api/sync/status`
- `GET /api/sync/diagnostics`
- `POST /api/sync/repair`

Common causes:

- Wrong `BRANCH_SYNC_TOKEN`.
- Supabase URL/key mismatch.
- Internet outage.
- Missing branch sync client registration in Supabase.

## Linux better-sqlite3 Error

Rebuild native bindings on Linux:

```bash
cd /opt/healthflow/local-branch-server
npm ci --omit=dev
npm run rebuild:sqlite
```

Install build tools if needed: `python3 make g++`.
