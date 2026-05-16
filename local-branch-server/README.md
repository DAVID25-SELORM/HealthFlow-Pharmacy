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

Then register each branch server with a long random token:

```sql
SELECT public.create_branch_sync_client(
  'Main branch laptop',
  '<organization_id>'::UUID,
  '<branch_id>'::UUID,
  '<long random branch sync token>'
);
```

Use that same plain token as `BRANCH_SYNC_TOKEN` in this local server. Supabase stores only the SHA-256 hash.

## Setup

```powershell
cd local-branch-server
copy .env.example .env
npm install
npm run start
```

In another terminal, run the sync worker:

```powershell
cd local-branch-server
npm run sync
```

On Windows, you can use the helper scripts instead:

```powershell
.\scripts\start-healthflow-offline.cmd
```

To start the local server and sync worker automatically when the Windows user signs in without leaving terminal windows open:

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
