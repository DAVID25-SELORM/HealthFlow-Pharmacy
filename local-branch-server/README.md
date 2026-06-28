# HealthFlow Local Branch Server

This package runs the **HealthFlow Branch Server** module for offline and local-network facility operations.

It runs on a facility laptop or a small branch computer on the local network. The React app can call this local API instead of calling Supabase directly while the branch is offline. The server writes dispensing, claims, inventory, patient, and branch activity to a local SQLite database, records every cloud-bound action in a sync outbox, and pushes pending events to Supabase when internet returns.

HealthFlow is the master platform. Dispensing, claims, NHIS, inventory, tariffs, and branch server workflows are modules under the same platform.

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
supabase/legacy/supabase-patch-branch-sync-rpcs.sql
```

Then register each facility branch machine from HealthFlow:

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

For facility-wide access from multiple computers, TLS is mandatory:

```env
HOST=0.0.0.0
HEALTHFLOW_TLS_CERT_PATH=C:\HealthFlowLocal\tls\branch-server.crt
HEALTHFLOW_TLS_KEY_PATH=C:\HealthFlowLocal\tls\branch-server.key
ALLOWED_ORIGINS=https://healthflow-branch.facility.example:4780
```

Use a certificate trusted by every facility computer. Without TLS, HealthFlow
binds to loopback only; it refuses a non-loopback listener so offline PINs and
staff sessions cannot accidentally cross the LAN in plaintext.

## Signed Branch Updates

The hosted admin page can check and install updates on a connected localhost
branch server. Vercel does not directly replace localhost files; the branch
server downloads and verifies a signed release package, then an external
installer stops the Windows NSSM service or Linux `systemd` service, backs up
the application, installs the update, and restarts it. `.env`, SQLite data,
and logs are preserved. A failed install restores the previous application
version.

Configure every facility server with the same update public key:

```env
HEALTHFLOW_UPDATE_MANIFEST_URL=https://updates.example.com/healthflow/manifest.json
HEALTHFLOW_UPDATE_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
HEALTHFLOW_UPDATE_CHANNEL=stable
HEALTHFLOW_UPDATE_AUTO_CHECK_HOURS=24
HEALTHFLOW_UPDATE_AUTO_INSTALL=false
```

Scheduled checks are enabled by default every 24 hours after these values are
configured. Installation still requires an administrator click unless
`HEALTHFLOW_UPDATE_AUTO_INSTALL=true` is explicitly set.

Generate an Ed25519 signing key once. Keep the private key outside this
repository and outside all facility computers. Node.js is sufficient:

```powershell
node local-branch-server\scripts\generate-update-keypair.mjs C:\secure\healthflow-update-keys
```

OpenSSL may also be used:

```powershell
openssl genpkey -algorithm Ed25519 -out healthflow-update-private.pem
openssl pkey -in healthflow-update-private.pem -pubout -out healthflow-update-public.pem
```

For each release, first refresh the offline bundle, increment
`local-branch-server/package.json`, and build the signed package:

```powershell
npm.cmd run build:offline
powershell -ExecutionPolicy Bypass -File local-branch-server\scripts\build-update-package.ps1 `
  -PackageBaseUrl "https://updates.example.com/healthflow" `
  -PrivateKeyPath "C:\secure\healthflow-update-private.pem" `
  -ReleaseNotes "Facility update notes"
```

Upload both generated files from `release\branch-updates` without changing
their contents. `manifest.json` may be replaced for each release; versioned ZIP
files should remain immutable.

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

## Production Linux Service Setup

For Linux branch computers, use the same Node server with a `systemd` service.
The Windows service scripts are not used on Linux.

Recommended Ubuntu/Debian prerequisites:

```bash
sudo apt update
sudo apt install -y git curl sudo unzip build-essential python3 make g++
node -v
npm -v
```

Use Node.js 20 or newer. The local server depends on native SQLite bindings.
The Linux installer removes copied `node_modules`, installs fresh dependencies,
and runs:

```bash
npm run rebuild:sqlite
```

That recompiles `better-sqlite3` for the Linux CPU/OS instead of reusing a
Windows-compiled binding.

Build the offline app bundle from the repository root before installing the
service:

```bash
npm install
npm run build:offline
```

Prepare the Linux branch server environment:

```bash
cd local-branch-server
cp .env.linux.example .env
npm install
npm run rebuild:sqlite
```

Edit `.env` and set the branch values generated from HealthFlow Offline Sync.
For Linux production installs, prefer this database path:

```env
HEALTHFLOW_DB_PATH=/var/lib/healthflow-branch/healthflow-branch.sqlite
```

If migrating an existing Windows branch server, keep these values unchanged:

```text
ORGANIZATION_ID
BRANCH_ID
BRANCH_SYNC_TOKEN
BRANCH_SERVER_TOKEN
NHIA_CONFIG_SECRET_KEY
```

Stop the Windows branch server before copying SQLite. Copy
`healthflow-branch.sqlite` and any matching `-wal` / `-shm` files into the Linux
database directory if those files exist.

Install the Linux service from the `local-branch-server` directory:

```bash
sudo bash scripts/install-linux-service.sh
sudo systemctl start healthflow-branch
sudo systemctl status healthflow-branch
```

The installer copies this package to:

```text
/opt/healthflow/local-branch-server
/var/lib/healthflow-branch
```

It also installs a narrow root-owned update helper:

```text
/usr/local/lib/healthflow/apply-update-linux.sh
/etc/healthflow-branch-updater.conf
/etc/sudoers.d/healthflow-branch-updater
```

The `healthflow` service account may run only that helper without a password.
The helper accepts only the fixed pending package path inside the installation
directory and a semantic version. It preserves `.env` and external SQLite
data, rebuilds `better-sqlite3`, verifies the protected health endpoint, and
rolls back if installation fails.

Existing Linux installations must run the installer once after upgrading to
this release:

```bash
sudo bash scripts/install-linux-service.sh
sudo systemctl restart healthflow-branch
```

After that bootstrap, **Check for Updates** and **Download and Install** work
from the HealthFlow Offline Sync page on Linux and Windows.

The service starts automatically on boot and restarts if Node exits. Follow logs:

```bash
sudo journalctl -u healthflow-branch -f
```

Run a health check:

```bash
bash scripts/health-check.sh
```

If other pharmacy machines must connect over LAN, allow the server port:

```bash
sudo ufw allow 4780/tcp
```

Then point those browsers to the Linux machine's LAN address, for example:

```text
http://192.168.1.10:4780
```

Uninstall only the service, preserving app files and SQLite data:

```bash
sudo bash scripts/uninstall-linux-service.sh
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

For NHIA CCC/CC generation, configure the upstream to match the HMS
`checkcccode.php` flow:

```env
CLAIMIT_UPSTREAM_BASE_URL=https://elig.nhia.gov.gh:5000
NHIA_ELIGIBILITY_BASE_URL=https://elig.nhia.gov.gh:5000
CLAIMIT_UPSTREAM_CREDENTIAL_MODE=api_key
CLAIMIT_UPSTREAM_MEMBER_LOOKUP_PATH=/api/hmis/genCCC
CLAIMIT_UPSTREAM_CC_ENDPOINT_PATH=/api/hmis/genCCC
NHIA_API_KEY_HEADER=x-nhia-apikey
NHIA_API_SECRET_HEADER=x-nhia-apisecret
NHIA_API_KEY=<NHIA API key>
NHIA_API_SECRET=<NHIA API secret>
```

The branch server sends:

```json
{ "CardNo": "member number or Ghana Card number", "CardType": "NHISCARD" }
```

For Ghana Card values beginning with `GHA`, `CardType` is sent as `GHANACARD`.

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
x-claim-bridge-token: <CLAIM_BRIDGE_TOKEN>
```

## API

Health check:

```http
GET /health
x-branch-token: <BRANCH_SERVER_TOKEN>
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

## Recommended facility installation model

Single workstation facility:

- Install this local branch server on the same laptop.
- Install the HealthFlow PWA in Edge or Chrome.
- Configure the PWA to call `http://localhost:4780` for offline-capable modules.

Multi-workstation facility:

- Install this local branch server on one always-on branch computer.
- Put all facility workstations on the same private LAN.
- Configure each workstation to call the branch server LAN address, for example `http://192.168.1.10:4780`.
