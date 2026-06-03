# HealthFlow Local Branch Server

This package is the starting point for serious offline pharmacy operations.

It runs on a pharmacy laptop or a small branch computer on the local network. The React app can later call this local API instead of calling Supabase directly while the branch is offline. The server writes pharmacy activity to a local SQLite database, records every cloud-bound action in a sync outbox, and pushes pending events to Supabase when internet returns.

## First supported slice

- Local inventory search from a cached inventory snapshot.
- Local POS sale creation.
- Local insurance claim creation from POS.
- Local stock reduction after sale.
- Local `stock_movements` records.
- Durable `sync_outbox` records.
- Supabase sync for `sale.completed` events through `branch_sync_create_sale_transaction`.
- Supabase sync for `claim.submitted` events through `branch_sync_create_claim_transaction`.

## Cloud Setup

Before enabling branch sync, run this SQL patch in Supabase:

```text
supabase-patch-branch-sync-rpcs.sql
```

Then register each pharmacy machine from HealthFlow:

1. Deploy the latest `tenant-signup` Edge Function.
2. Sign in as `super_admin`.
3. Open **Offline Sync**.
4. In **Branch Sync Setup**, select the organization.
5. Use the existing branch, or let HealthFlow generate and create one automatically.
6. Leave **Branch sync token** blank to generate a secure token.
7. Click **Register Sync Client**.
8. Copy the generated `.env` block into this local server's `.env`.

The generated values include `ORGANIZATION_ID`, `BRANCH_ID`, `BRANCH_SYNC_TOKEN`, and
`SUPABASE_URL`. Use the Supabase anon/publishable key for `SUPABASE_SYNC_KEY`.
Supabase stores only the SHA-256 hash of `BRANCH_SYNC_TOKEN`.

## Setup

```powershell
cd local-branch-server
copy .env.example .env
npm install
npm run start
```

At minimum, set these values before starting:

```env
PORT=4780
BRANCH_SERVER_TOKEN=<long-random-local-server-token>
ORGANIZATION_ID=<from-branch-sync-setup>
BRANCH_ID=<from-branch-sync-setup>
BRANCH_SYNC_TOKEN=<from-branch-sync-setup>
SUPABASE_URL=<from-branch-sync-setup>
SUPABASE_SYNC_KEY=<supabase-anon-or-publishable-key>
```

`npm run start` starts the local API/POS server and the embedded sync worker loop. Use the standalone sync command only for diagnostics:

```powershell
cd local-branch-server
npm run sync -- --once
```

## Production Windows Service Setup

For production branch computers, install HealthFlow as a Windows background service. Cashiers should not need PowerShell after this setup.

NSSM is bundled at `local-branch-server\deployment\windows\nssm\win64\nssm.exe` and handled by the installer. If it is missing and internet is available, `install-service.ps1` downloads NSSM automatically as a recovery fallback.

### Pharmacy Machine Installation

Run PowerShell as Administrator from the copied `local-branch-server` folder:

```powershell
cd "C:\Users\Realtime IT\Desktop\local-branch-server"
npm run install:windows-service
```

The installer creates:

```text
HealthFlowOfflineServer -> node src/server.js
C:\HealthFlowLocal\local-branch-server
C:\HealthFlowLocal\logs
C:\HealthFlowLocal\data
C:\HealthFlowLocal\nssm\nssm.exe
Public desktop shortcut: HealthFlow Offline POS
```

The Windows service starts automatically when Windows boots and restarts automatically if the Node process crashes. It runs with:

```text
HEALTHFLOW_DB_PATH=C:\HealthFlowLocal\data\healthflow-branch.sqlite
```

The server process also starts the sync worker loop, so SQLite outbox records keep retrying automatically when internet returns. After installation, cashiers should open the POS with the **HealthFlow Offline POS** desktop shortcut or:

```text
http://localhost:4780
```

Run a health check:

```powershell
cd "C:\HealthFlowLocal\local-branch-server"
npm run health:check
```

Uninstall the Windows service:

```powershell
cd "C:\HealthFlowLocal\local-branch-server"
npm run uninstall:windows-service
```

Restart the service:

```powershell
npm run restart:service
```

The uninstall command preserves `.env`, SQLite data, and logs by default. Use the script's `-RemoveFiles` switch only when intentionally decommissioning a branch server.

On Windows, you can use the helper BAT launcher as a manual backup only. It keeps `npm start` behavior and sets the production database path for the current console session:

```powershell
.\scripts\start-local-server.bat
```

The older Task Scheduler path is retained for fallback environments where services are blocked. It starts the server task only, because the server starts the sync worker loop internally:

```powershell
npm run install:startup
```

This creates two Windows Task Scheduler tasks and starts them immediately. Logs are written to `local-branch-server/logs`.

To remove the startup tasks later:

```powershell
npm run uninstall:startup
```

If Task Scheduler is blocked on a machine, you can use the older Startup folder shortcut fallback:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup-shortcut.ps1
```

The server defaults to:

```text
http://localhost:4780
```

Every `/api/*` request must include:

```text
x-branch-token: your BRANCH_SERVER_TOKEN
```

## Important security note

Use `SUPABASE_SYNC_KEY` plus `BRANCH_SYNC_TOKEN` for sync. The recommended sync key is your Supabase anon or publishable key, because the dedicated RPCs verify the branch token themselves.

Avoid putting a service role key on ordinary cashier laptops. Never expose any sync token or Supabase service role key in the React frontend, browser storage, Vercel public environment variables, or any client-side file.

Payment provider secrets follow the same rule. Keep `PAYSTACK_SECRET_KEY`, `HUBTEL_CLIENT_ID`, and `HUBTEL_CLIENT_SECRET` in `local-branch-server/.env` or another backend environment only. The POS asks this server to initiate a payment; it never stores provider secrets in browser localStorage.

## Payment Setup

The POS supports Cash, Mobile Money, Card, Insurance, and NHIA Claim. Cash, Insurance, and NHIA keep the existing local-sale behavior. Mobile Money and Card create a local sale as `pending_payment`, create a unique payment reference, and initiate Hubtel or Paystack from the branch server. A verified webhook marks the sale paid and then queues the normal `sale.completed` sync event.

Configure only the providers you use:

```text
PAYMENT_DEFAULT_PROVIDER=paystack
PAYMENT_PUBLIC_BASE_URL=https://your-public-branch-server.example.com

PAYSTACK_ENABLED=true
PAYSTACK_SECRET_KEY=sk_live_xxx
PAYSTACK_DEFAULT_EMAIL=payments@yourdomain.com

HUBTEL_ENABLED=true
HUBTEL_CLIENT_ID=xxx
HUBTEL_CLIENT_SECRET=xxx
HUBTEL_REQUEST_MONEY_PATH=/request-money/{mobileNumber}
```

Set provider dashboard webhooks to:

```text
POST /api/payments/webhook/paystack
POST /api/payments/webhook/hubtel
```

If the branch server or internet is offline, use Cash. Mobile Money and Card are disabled in the POS until the local branch server is reachable and the browser is online.

## Production CLAIM-it Bridge Setup

For production NHIA submission from the Vercel app, do not use `localhost`.
Deploy this server behind a public HTTPS domain and enable the CLAIM-it bridge
proxy:

```env
NODE_ENV=production
PORT=4780
BRANCH_SERVER_TOKEN=<long-random-token-for-/api-routes>

CLAIM_BRIDGE_ENABLED=true
CLAIM_BRIDGE_PUBLIC_PATH=/json-api
CLAIMIT_UPSTREAM_BASE_URL=https://official-claimit-or-nhia-host.example.com
CLAIM_BRIDGE_TOKEN=<long-random-production-bridge-token>
CLAIM_BRIDGE_TOKEN_HEADER=x-claim-bridge-token
CLAIM_BRIDGE_TIMEOUT_MS=30000

# Optional upstream auth, stored only on the bridge server:
CLAIMIT_UPSTREAM_API_KEY=
CLAIMIT_UPSTREAM_API_KEY_HEADER=x-api-key
CLAIMIT_UPSTREAM_API_SECRET=
CLAIMIT_UPSTREAM_API_SECRET_HEADER=x-api-secret
CLAIMIT_UPSTREAM_BEARER_TOKEN=
CLAIMIT_UPSTREAM_USERNAME=
CLAIMIT_UPSTREAM_PASSWORD=
```

For Healthmanager / Ark Medical-style CC lookup endpoints that post `unm`, `key`, and `secret`
as form data, configure the upstream like this:

```env
CLAIMIT_UPSTREAM_BASE_URL=http://server-pc:9090
CLAIMIT_UPSTREAM_CREDENTIAL_MODE=healthmanager_form
CLAIMIT_UPSTREAM_MEMBER_LOOKUP_PATH=/checkcccode.php
CLAIMIT_UPSTREAM_CC_ENDPOINT_PATH=/checkcccode.php
CLAIMIT_UPSTREAM_API_KEY=<form key value>
CLAIMIT_UPSTREAM_API_SECRET=<form secret value>
```

Point DNS/reverse proxy traffic from:

```text
https://claimbridge.healthflowgh.com/json-api
```

to this server's `CLAIM_BRIDGE_PUBLIC_PATH`. The bridge forwards:

```text
https://claimbridge.healthflowgh.com/json-api/<endpoint-path>
```

to:

```text
CLAIMIT_UPSTREAM_BASE_URL/<endpoint-path>
```

In HealthFlow Settings use:

```text
Integration mode: CLAIM-it Local Bridge API
Connection profile: Production bridge server
Base URL: https://claimbridge.healthflowgh.com/json-api
Credential mode: API key
API key header: x-claim-bridge-token
API key: <CLAIM_BRIDGE_TOKEN>
```

Keep the official CLAIM-it/NHIA host, provider credentials, and bridge token in
backend environments only. The bridge health endpoint is:

```http
GET /json-api/health
```

## API

Health check:

```http
GET /health
```

Import inventory snapshot:

```http
POST /api/inventory/import
```

Body:

```json
{
  "drugs": [
    {
      "id": "uuid-from-supabase",
      "name": "Paracetamol 500mg",
      "batch_number": "BT001",
      "quantity": 100,
      "price": 5,
      "branch_id": "branch-uuid"
    }
  ]
}
```

Search local inventory:

```http
GET /api/inventory/search?q=para&limit=30
```

Create a local sale:

```http
POST /api/sales
```

Body:

```json
{
  "patientId": null,
  "paymentMethod": "cash",
  "amountPaid": 20,
  "change": 5,
  "discount": 0,
  "soldBy": "user-uuid",
  "shiftId": "shift-uuid",
  "organizationId": "organization-uuid",
  "branchId": "branch-uuid",
  "items": [
    {
      "drugId": "drug-uuid",
      "name": "Paracetamol 500mg",
      "quantity": 3,
      "price": 5
    }
  ]
}
```

Create a local insurance sale with a claim:

```http
POST /api/sales
```

Body:

```json
{
  "patientId": "patient-uuid",
  "paymentMethod": "insurance",
  "amountPaid": 15,
  "insuranceCoveredAmount": 10,
  "insuranceTopUpAmount": 5,
  "insuranceTopUpPaymentMethod": "cash",
  "soldBy": "user-uuid",
  "shiftId": "shift-uuid",
  "organizationId": "organization-uuid",
  "branchId": "branch-uuid",
  "items": [
    {
      "drugId": "drug-uuid",
      "name": "Paracetamol 500mg",
      "quantity": 3,
      "price": 5
    }
  ],
  "claimPayload": {
    "patientId": "patient-uuid",
    "patientName": "Ama Mensah",
    "insuranceProvider": "NHIS",
    "insuranceId": "NHIS123456",
    "serviceDate": "2026-05-09",
    "submittedBy": "user-uuid",
    "branchId": "branch-uuid",
    "items": [
      {
        "drugId": "drug-uuid",
        "name": "Paracetamol 500mg",
        "quantity": 3,
        "price": 3.33
      }
    ]
  }
}
```

Run sync once:

```http
POST /api/sync/run
```

Pull cloud inventory into the local branch database:

```http
POST /api/sync/pull-inventory
```

## Recommended pharmacy installation model

Single laptop pharmacy:

- Install this local branch server on the same laptop.
- Install the HealthFlow PWA in Edge or Chrome.
- Configure the PWA to call `http://localhost:4780` for offline-capable modules.

Multi-laptop pharmacy:

- Install this local branch server on one always-on branch computer.
- Put all pharmacy laptops on the same LAN.
- Configure every laptop to call the branch server LAN address, for example `http://192.168.1.10:4780`.

## Next implementation steps

1. Add a frontend `branchApi` service that chooses local branch server first for POS when enabled.
2. Add inventory snapshot pull from Supabase into `/api/inventory/import`.
3. Add local patients, purchases, and shift close.
4. Add conflict screens for stock changes that fail on cloud sync.
5. Package this server as a Windows service for pharmacy laptops.
