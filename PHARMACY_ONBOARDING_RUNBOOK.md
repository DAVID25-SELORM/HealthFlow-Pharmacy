# HealthFlow Pharmacy Onboarding Runbook

Use this document when setting up a new pharmacy on HealthFlow.

There are two onboarding paths:

- **Cloud pharmacy**: users only use the online HealthFlow app.
- **Server pharmacy**: one local branch server computer plus other computers on the same LAN.

## 1. Cloud Pharmacy Onboarding

Use this for a pharmacy that will use the normal online app without a local branch server.

### Process

1. Create the pharmacy/organization through `/signup` or Super Admin.
2. Set pharmacy name, owner/admin user, and main branch.
3. Assign the subscription plan.
4. Enable modules based on the plan:
   - Inventory
   - Sales POS
   - Patients
   - Claims
   - Purchases
   - NHIS
   - Accounting
   - Reports
5. Configure receipt details:
   - Pharmacy logo
   - Address
   - Phone
   - Slogan
   - Receipt footer
6. Add staff users and assign roles.
7. Import starting inventory.
8. Test the workflow:
   - Add a drug
   - Search inventory
   - Make a sale
   - Print receipt
   - Add a patient
   - Submit a claim if Claims is enabled
   - Check reports
9. Train users and hand over login details.

### Deployment Machine Checks

Run these commands from the project root:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"

npm install
npm.cmd run build
npm.cmd run test
```

If deploying through GitHub/Vercel:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"

git status
git add -A
git commit -m "Prepare pharmacy onboarding"
git push origin main
```

### Supabase Setup Checklist

For a fresh Supabase project, run the base schema/migrations in SQL Editor.

Recommended order:

```text
supabase-schema.sql
supabase-migration-multi-tenant-step1.sql
supabase-migration-multi-tenant-step2-rls.sql
supabase-migration-multi-tenant-step3-fixes.sql
supabase-migration-branches.sql
supabase-migration-purchases.sql
supabase-migration-nhis.sql
supabase-migration-accounting.sql
supabase-patch-branch-sync-rpcs.sql
```

Then apply current patches used by the live app:

```text
supabase-patch-inventory-workflow-controls.sql
supabase-patch-commercial-billing-controls.sql
supabase-patch-nhis-topup-controls.sql
supabase-patch-branch-sync-rpcs.sql
supabase-patch-accounting-defaults.sql
supabase-patch-accounting-hardening.sql
```

Do not rerun full base schema blindly on an existing production database. Use patch files for existing deployments.

## 2. Server Pharmacy / Multi-Computer Onboarding

Use this when the pharmacy has more than one computer and needs a local branch server.

### Recommended Network Layout

- One always-on computer is the **Branch Server Computer**.
- Other computers are **Cashier/Staff Computers**.
- All computers must be on the same Wi-Fi/LAN.
- Branch server runs on port `4780`.
- Staff computers connect to the server using the branch server LAN IP, for example:

```text
http://192.168.1.10:4780
```

## 3. Branch Server Computer Setup

Open PowerShell on the branch server computer.

### Install Dependencies

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy\local-branch-server"

npm install
Copy-Item .env.example .env
```

### Generate Secure Tokens

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$branchServerToken = [Convert]::ToBase64String($bytes)

$bytes2 = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes2)
$branchSyncToken = [Convert]::ToBase64String($bytes2)

"BRANCH_SERVER_TOKEN=$branchServerToken"
"BRANCH_SYNC_TOKEN=$branchSyncToken"
```

Copy both values somewhere secure.

### Configure `.env`

```powershell
notepad .env
```

Set values like this:

```env
PORT=4780
BRANCH_SERVER_TOKEN=<generated-branch-server-token>
BRANCH_ID=<branch-id-from-supabase>
ORGANIZATION_ID=<organization-id-from-supabase>
SQLITE_PATH=./data/healthflow-branch.sqlite
SYNC_INTERVAL_SECONDS=30
INVENTORY_PULL_INTERVAL_SECONDS=300
BRANCH_SYNC_TOKEN=<generated-branch-sync-token>
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SYNC_KEY=your-supabase-publishable-or-anon-key
```

Important:

- `BRANCH_SERVER_TOKEN` is used by cashier computers to call the local server.
- `BRANCH_SYNC_TOKEN` is used by the local server to sync with Supabase.
- Do not put the Supabase service role key on ordinary cashier laptops.
- Prefer the Supabase publishable/anon key plus the branch sync token.

## 4. Register Branch Sync Client In Supabase

Before sync will work, run this in Supabase SQL Editor:

```sql
SELECT public.create_branch_sync_client(
  'Main branch server',
  '<organization_id>'::UUID,
  '<branch_id>'::UUID,
  '<BRANCH_SYNC_TOKEN_FROM_ENV>'
);
```

The token must match the `BRANCH_SYNC_TOKEN` in the local branch server `.env`.

## 5. Start Branch Server Manually

Terminal 1:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy\local-branch-server"
npm run start
```

Terminal 2:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy\local-branch-server"
npm run sync
```

## 6. Test The Local Server

Health check:

```powershell
Invoke-WebRequest -Uri "http://localhost:4780/health" -UseBasicParsing
```

Protected route test:

```powershell
$token = "<BRANCH_SERVER_TOKEN_FROM_ENV>"

Invoke-WebRequest `
  -Uri "http://localhost:4780/api/sync/status" `
  -Headers @{ "x-branch-token" = $token } `
  -UseBasicParsing
```

Expected result: HTTP `200`.

## 7. Allow Other Computers On The LAN

Find the branch server computer's LAN IP:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object IPAddress, InterfaceAlias
```

Example:

```text
192.168.1.10
```

Open firewall port `4780`:

```powershell
New-NetFirewallRule `
  -DisplayName "HealthFlow Branch Server 4780" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 4780 `
  -Action Allow
```

From another computer, test:

```powershell
Test-NetConnection 192.168.1.10 -Port 4780
Invoke-WebRequest -Uri "http://192.168.1.10:4780/health" -UseBasicParsing
```

## 8. Install Auto Startup

Once manual tests pass, install startup tasks on the branch server computer:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy\local-branch-server"
npm run install:startup
```

This starts:

- HealthFlow local branch server
- HealthFlow sync worker

Logs are written to:

```text
local-branch-server/logs
```

To remove startup tasks later:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy\local-branch-server"
npm run uninstall:startup
```

If Task Scheduler is blocked, use the Startup folder shortcut fallback:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy\local-branch-server"
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup-shortcut.ps1
```

## 9. Configure Cashier/Staff Computers

On each cashier/staff computer:

1. Open the HealthFlow app.
2. Go to Sales POS.
3. Find the **Local Branch Server** panel.
4. Click **Configure**.
5. Enter:

```text
URL: http://192.168.1.10:4780
Token: <BRANCH_SERVER_TOKEN_FROM_ENV>
```

6. Click **Check**.
7. Click **Pull Inventory**.
8. Click **Sync Now**.

Use the real LAN IP for the branch server computer.

## 10. Final Acceptance Test

On a cashier computer:

1. Search for a drug in POS.
2. Add item to cart.
3. Complete a sale.
4. Print receipt.
5. Check local sync status.

PowerShell sync status check:

```powershell
$token = "<BRANCH_SERVER_TOKEN_FROM_ENV>"

Invoke-WebRequest `
  -Uri "http://192.168.1.10:4780/api/sync/status" `
  -Headers @{ "x-branch-token" = $token } `
  -UseBasicParsing
```

Then confirm the sale eventually appears in Supabase/HealthFlow cloud.

## 11. Onboarding Record Template

Keep this for every pharmacy:

```text
Pharmacy Name:
Organization ID:
Main Branch ID:
Admin Name:
Admin Email:
Admin Phone:
Plan:
Enabled Modules:
Number of Branches:
Number of Staff:
Branch Server Required: Yes/No
Branch Server Computer Name:
Branch Server LAN IP:
Branch Server URL:
Setup Date:
Installed By:
Training Completed: Yes/No
Notes:
```

Keep tokens in a password manager or secure admin record. Do not store live tokens in WhatsApp chats or public documents.

## 12. Troubleshooting Commands

Check app build:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
npm.cmd run build
```

Check local branch server syntax:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
Get-ChildItem local-branch-server\src -Filter *.js | ForEach-Object { node --check $_.FullName }
```

Check branch server port:

```powershell
Test-NetConnection localhost -Port 4780
```

Check branch server health:

```powershell
Invoke-WebRequest -Uri "http://localhost:4780/health" -UseBasicParsing
```

Check LAN access:

```powershell
Test-NetConnection <branch-server-ip> -Port 4780
```

Check Git status before pushing:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
git status
```

