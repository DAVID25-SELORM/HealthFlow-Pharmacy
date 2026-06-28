# HealthFlow Pharmacy Onboarding Runbook

Use this document when setting up a new pharmacy or hospital pharmacy on HealthFlow.

There are two onboarding paths:

- **Cloud pharmacy**: users only use the hosted HealthFlow app.
- **Server pharmacy**: one local branch server computer plus other computers on the same LAN.

Most new facilities should be onboarded in the cloud first. Add the local branch server only when the facility needs offline POS, LAN sharing, local inventory cache, local claims, or direct payment initiation from the branch machine.

## 1. Pre-Onboarding Information To Collect

Collect these before touching the machine:

```text
Facility legal/trading name:
Facility type: Pharmacy/Hospital/Clinic
Primary admin name:
Primary admin email:
Primary admin phone:
Branch name:
Branch address:
Branch phone:
Subscription plan:
Enabled modules:
Staff list and roles:
Logo available: Yes/No
Receipt slogan/footer:
Starting inventory file available: Yes/No
NHIA/ClaimIT needed: Yes/No
NHIA facility code:
NHIA provider number:
NHIA provider type description:
NHIA provider class/level:
Claims officer name:
Claims officer signature uploaded: Yes/No
Hubtel needed: Yes/No
Paystack needed: Yes/No
Branch server needed: Yes/No
```

Keep provider secrets, branch tokens, and Supabase sync keys in a password manager or secure admin record. Do not store live secrets in WhatsApp chats, screenshots, public docs, or frontend localStorage.

## 2. Required Software For New Machines

### Branch Server Computer

Install these on the one always-on branch server computer:

```text
Windows 10/11
PowerShell
Node.js ^20.19.0 or >=22.12.0
npm, installed with Node.js
Git for Windows
Google Chrome or Microsoft Edge
Stable internet
Stable LAN/Wi-Fi connection
Admin access for firewall and Windows service setup
```

Node version is important because this app uses Vite 8, which requires Node `^20.19.0` or `>=22.12.0`.

Optional only if `npm install` fails while building `better-sqlite3`:

```text
Visual Studio Build Tools with Desktop development with C++
Python 3
```

If Windows Package Manager is available, install the basics with:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Google.Chrome
```

Close and reopen PowerShell after installing Node.js or Git.

NSSM is bundled with the HealthFlow offline deployment and copied automatically by the service installer. Pharmacies should not manually configure NSSM. The bundled Windows x64 binary lives at:

```text
local-branch-server\deployment\windows\nssm\win64\nssm.exe
```

Bundled NSSM checksum:

```text
SHA-256: F689EE9AF94B00E9E3F0BB072B34CAAF207F32DCB4F5782FC9CA351DF9A06C97
```

During installation, HealthFlow copies it to `C:\HealthFlowPharmacy\nssm\nssm.exe`. If the binary is missing and internet is available, `install-service.ps1` can still download NSSM automatically as a recovery fallback.

### Cashier/Staff Computers

Install these on each cashier/staff computer:

```text
Google Chrome or Microsoft Edge
Same LAN/Wi-Fi access as the branch server
No Node.js required unless the machine will also run the branch server
```

## 3. Verify Installed Software

Open PowerShell and run:

```powershell
node -v
npm -v
git --version
```

Expected:

```text
node should be v20.19.x, v22.12.0 or newer
npm should print a version
git should print a version
```

If `node`, `npm`, or `git` is not recognized, install or repair the missing software and reopen PowerShell.

## 4. Cloud Pharmacy Onboarding

Use this for a facility that will use the normal online app without a local branch server.

1. Create the pharmacy/organization through `/signup` or Super Admin.
2. Set facility name, owner/admin user, and main branch.
3. Assign the subscription plan.
4. Enable modules based on the plan:

```text
Inventory
Sales POS
Patients
Claims
Purchases
NHIS/NHIA
Accounting
Reports
```

5. Configure receipt details:

```text
Logo
Address
Phone
Slogan
Receipt footer
```

6. Add staff users and assign roles.
7. Import starting inventory.
8. Configure NHIA/ClaimIT if required.
9. Configure payment provider credentials on the backend/local server if required.
10. Test core workflows:

```text
Add/search drug
Make cash sale
Print receipt
Add patient
Submit insurance/NHIA claim if enabled
Record purchase if enabled
Check reports
```

11. Train users and hand over login details.

## 5. Developer/Deployment Machine Commands

Run these from the project root before deploying updates:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
npm install
npm.cmd run build
npm.cmd run test
```

Build the offline app bundle used by the local branch server:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
npm.cmd run build:offline
```

If deploying through GitHub/Vercel:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
git status
git add -A
git commit -m "Prepare pharmacy onboarding"
git push origin main
```

## 6. Supabase Setup Checklist

For a fresh Supabase project, run the base schema/migrations in SQL Editor.

Recommended order:

```text
supabase-schema.sql
supabase/legacy/supabase-migration-multi-tenant-step1.sql
supabase/legacy/supabase-migration-multi-tenant-step2-rls.sql
supabase/legacy/supabase-migration-multi-tenant-step3-fixes.sql
supabase/legacy/supabase-migration-branches.sql
supabase/legacy/supabase-migration-purchases.sql
supabase/legacy/supabase-migration-nhis.sql
supabase/legacy/supabase-migration-accounting.sql
```

Then apply current patches used by the live app:

```text
supabase/legacy/supabase-patch-branch-sync-rpcs.sql
supabase/legacy/supabase-patch-inventory-workflow-controls.sql
supabase/legacy/supabase-patch-commercial-billing-controls.sql
supabase/legacy/supabase-patch-nhis-topup-controls.sql
supabase/legacy/supabase-patch-diagnosis-catalog.sql
supabase/legacy/supabase-patch-nhis-prescription-attachments.sql
supabase/legacy/supabase-patch-accounting-defaults.sql
supabase/legacy/supabase-patch-accounting-hardening.sql
supabase/legacy/supabase-patch-shift-system.sql
supabase/legacy/supabase-patch-sale-transaction-hardening.sql
supabase/legacy/supabase-patch-refund-admin-and-clear-rooter.sql
supabase/legacy/supabase-patch-refund-permission-and-reprints.sql
supabase/legacy/supabase-patch-expanded-staff-roles.sql
supabase/legacy/supabase-patch-organization-module-privileges.sql
supabase/legacy/supabase-patch-organization-type.sql
supabase/legacy/supabase-patch-nhia-readiness-fields.sql
supabase/legacy/supabase-patch-nhia-api-integrations.sql
supabase/legacy/supabase-patch-nhis-claims-officer-review.sql
```

After applying `supabase/legacy/supabase-patch-diagnosis-catalog.sql`, seed the diagnosis dropdown catalog:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
$env:SUPABASE_URL="https://your-project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
npm run seed:diagnosis-catalog
```

Do not rerun the full base schema blindly on an existing production database. Use patch files for existing deployments.

## 7. Server Pharmacy / Multi-Computer Layout

Use this when the facility has more than one computer or needs reliable offline POS.

Recommended layout:

```text
One always-on computer: Branch Server Computer
Other computers: Cashier/Staff Computers
Network: Same LAN/Wi-Fi
Branch server port: 4780
Example branch server URL: https://healthflow-branch.facility.example:4780
```

Plain HTTP is supported only on the branch server itself (`127.0.0.1`).
Multi-computer access requires a certificate trusted by every staff computer.
Set `HOST=0.0.0.0`, `HEALTHFLOW_TLS_CERT_PATH`, and
`HEALTHFLOW_TLS_KEY_PATH`. If the certificate is missing or invalid, the
server reports `TLS Not Configured` and safely falls back to local-only mode.

For Hubtel/Paystack webhooks, the payment provider must also reach the branch server over HTTPS. Use one of these:

```text
Public HTTPS domain/reverse proxy
Cloudflare Tunnel
ngrok or another secure tunnel for testing
Backend-hosted branch payment server
```

Do not use `localhost` as a provider webhook URL. Provider webhooks must be reachable from the internet.

## 8. Install The Project On The Branch Server Computer

Open PowerShell.

Create a folder:

```powershell
New-Item -ItemType Directory -Force "C:\HealthFlowPharmacy"
cd "C:\HealthFlowPharmacy"
```

Clone the repo:

```powershell
git clone https://github.com/DAVID25-SELORM/HealthFlow-Pharmacy.git "."
cd "C:\HealthFlowPharmacy"
```

Install and build the frontend:

```powershell
npm install
npm.cmd run build
npm.cmd run build:offline
```

Install the local branch server dependencies:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm install
```

Create the branch server `.env` if it does not already exist:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

If the facility was installed from a zip instead of Git, extract the zip to:

```text
C:\HealthFlowPharmacy
```

Then run the same `npm install`, `npm.cmd run build`, `npm.cmd run build:offline`, and local branch server `npm install` commands.

## 9. Generate Secure Branch Tokens

Run this on the branch server computer:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$branchServerToken = [Convert]::ToBase64String($bytes)

"BRANCH_SERVER_TOKEN=$branchServerToken"
```

Copy the `BRANCH_SERVER_TOKEN` into the secure admin record. The `BRANCH_SYNC_TOKEN`,
`ORGANIZATION_ID`, `BRANCH_ID`, and `SUPABASE_URL` are generated later from the
Super Admin **Offline Sync** page.

## 10. Configure `local-branch-server/.env`

Open:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
notepad .env
```

Set these core values. The branch sync values come from section 13.

```env
PORT=4780
HOST=0.0.0.0
HEALTHFLOW_TLS_CERT_PATH=C:\HealthFlowLocal\tls\branch-server.crt
HEALTHFLOW_TLS_KEY_PATH=C:\HealthFlowLocal\tls\branch-server.key
BRANCH_SERVER_TOKEN=<generated-branch-server-token>
ALLOWED_ORIGINS=
ORGANIZATION_ID=<from-branch-sync-setup>
BRANCH_ID=<from-branch-sync-setup>
SQLITE_PATH=./data/healthflow-branch.sqlite
SYNC_INTERVAL_SECONDS=30
INVENTORY_PULL_INTERVAL_SECONDS=300
BRANCH_SYNC_TOKEN=<from-branch-sync-setup>
SUPABASE_URL=<from-branch-sync-setup>
SUPABASE_SYNC_KEY=your-supabase-anon-or-publishable-key
```

Important:

- `BRANCH_SERVER_TOKEN` lets cashier computers call the local server.
- The TLS certificate must contain the DNS name staff computers use and must be
  issued by a CA trusted by those computers. Do not bypass certificate warnings.
- `BRANCH_SYNC_TOKEN` lets the local server sync with Supabase.
- `SUPABASE_SYNC_KEY` should normally be the Supabase anon/publishable key.
- Avoid putting a service role key on ordinary cashier laptops.
- Do not put `BRANCH_SYNC_TOKEN`, Supabase keys, or payment provider secrets in frontend localStorage, React code, or Vercel public environment variables.
- Do not set `VITE_BRANCH_SERVER_TOKEN`; it would bake the branch token into a browser bundle. The branch server injects local runtime config for the offline POS, and LAN staff machines use the POS Configure button for the local `BRANCH_SERVER_TOKEN`.

## 11. Payment Provider `.env` Setup

Add or update this block in `local-branch-server/.env`:

```env
PAYMENT_DEFAULT_PROVIDER=paystack
PAYMENT_CURRENCY=GHS
PAYMENT_PUBLIC_BASE_URL=https://CHANGE_ME_BRANCH_SERVER_PUBLIC_DOMAIN
PAYMENT_RETURN_URL=https://CHANGE_ME_APP_RETURN_URL/sales

PAYSTACK_ENABLED=false
PAYSTACK_BASE_URL=https://api.paystack.co
PAYSTACK_SECRET_KEY=CHANGE_ME_PAYSTACK_SECRET_KEY
PAYSTACK_DEFAULT_EMAIL=payments@CHANGE_ME_FACILITY_DOMAIN

HUBTEL_ENABLED=false
HUBTEL_BASE_URL=https://CHANGE_ME_HUBTEL_API_BASE_URL
HUBTEL_CLIENT_ID=CHANGE_ME_HUBTEL_CLIENT_ID
HUBTEL_CLIENT_SECRET=CHANGE_ME_HUBTEL_CLIENT_SECRET
HUBTEL_REQUEST_MONEY_PATH=/request-money/{mobileNumber}
HUBTEL_WEBHOOK_SECRET=CHANGE_ME_HUBTEL_WEBHOOK_SECRET
```

Enable only the providers the facility will use:

```env
PAYSTACK_ENABLED=true
HUBTEL_ENABLED=true
```

Provider dashboard webhook URLs:

```text
https://your-branch-server-domain.com/api/payments/webhook/paystack
https://your-branch-server-domain.com/api/payments/webhook/hubtel
```

Rules:

- Paystack and Hubtel can both be enabled.
- Card should normally use Paystack.
- Mobile Money can use Hubtel or Paystack.
- Cash works offline.
- Mobile Money/Card require internet and local branch server access.
- Payment secrets stay in `.env` or backend environment only.

After changing `.env`, restart the branch server.

## 12. NHIA / ClaimIT Setup

For pharmacies or hospitals using NHIA/ClaimIT:

1. Apply the NHIA SQL patches listed in the Supabase setup.
2. Open HealthFlow Settings.
3. Configure NHIA/ClaimIT fields:

```text
Facility code
Provider number
Scheme name
Provider type description
Provider class/level
Claims officer name
Admission payment option
ClaimIT validation enabled
Claims officer signature upload if available
API environment
API base URL
Claim endpoint path
CC/CCC code endpoint path
Claim status endpoint path
Member lookup endpoint path
Credential mode
Credential payload through backend/service role only
```

For pharmacy provider class/level, use the exact class registered for the facility by NHIA/NHIS. If the facility is a pharmacy-only provider, do not choose a hospital class. If unsure, confirm from the provider's NHIA registration certificate or ClaimIT profile.

## 13. Register Branch Sync Client

Before sync will work, register the pharmacy machine from HealthFlow.

Prerequisites:

- Deploy the latest `tenant-signup` Edge Function after code updates:

```powershell
cd "C:\HealthFlowPharmacy"
npx.cmd supabase functions deploy tenant-signup
```

- Confirm `supabase/legacy/supabase-patch-branch-sync-rpcs.sql` has already been applied in Supabase.
- Sign in to HealthFlow as a `super_admin`.

Registration steps:

1. Open **Offline Sync** from the platform dashboard.
2. In **Branch Sync Setup**, select the organization.
3. Leave **Branch** as the selected branch. If no branch exists or is visible, HealthFlow generates a branch UUID and creates the branch during registration.
4. Keep **Client name** as `Main branch server`, or rename it to identify the machine, for example `ARK Medical Centre - Main POS Server`.
5. Leave **Branch sync token** blank unless you are restoring a known token. HealthFlow generates a secure token.
6. Click **Register Sync Client**.
7. Copy the generated `.env` block into `local-branch-server/.env` on the pharmacy machine:

```env
ORGANIZATION_ID=<generated-organization-id>
BRANCH_ID=<generated-or-selected-branch-id>
BRANCH_SYNC_TOKEN=<generated-branch-sync-token>
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SYNC_KEY=<your-supabase-anon-or-publishable-key>
```

Rules:

- `BRANCH_SYNC_TOKEN` is shown only as the plain value for setup. Supabase stores only its SHA-256 hash.
- Use the Supabase anon/publishable key for `SUPABASE_SYNC_KEY`.
- Do not put the Supabase service role key on ordinary cashier laptops.
- Do not use SQL Editor for normal branch sync registration anymore; use the protected Super Admin setup flow.

## 14. Start Branch Server Manually

Manual startup is only for setup testing and technician recovery. The server process also starts the sync worker loop, so do not start a second long-running sync worker at the same time.

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm run start
```

Optional one-time sync diagnostic:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm run sync -- --once
```

Leave the manual server terminal open only during testing. Production machines should use the NSSM service in section 17.

## 15. Test The Local Server

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

Syntax checks:

```powershell
cd "C:\HealthFlowPharmacy"
node --check local-branch-server\src\server.js
node --check local-branch-server\src\syncWorker.js
node --check local-branch-server\src\paymentsRepository.js
node --check local-branch-server\src\salesRepository.js
```

## 16. Allow Other Computers On The LAN

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

Open firewall port `4780`. Run PowerShell as Administrator:

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

## 17. Install Production Windows Service

Once manual tests pass, install the production Windows service on the branch server computer. Run PowerShell as Administrator:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm run install:service
```

This starts:

```text
HealthFlowOfflineServer
```

The single service runs `node src/server.js` from `C:\HealthFlowPharmacy\local-branch-server`. The server process starts the local POS/API and the sync worker loop, so pending SQLite data continues to sync when internet returns.

Logs are written to:

```text
C:\HealthFlowPharmacy\logs
```

Data is stored under:

```text
C:\HealthFlowPharmacy\data
```

NSSM is stored under:

```text
C:\HealthFlowPharmacy\nssm
```

The installer configures automatic startup, crash restart recovery, stdout/stderr logging, and a desktop shortcut named:

```text
HealthFlow Offline POS
```

Run a health check:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm run health:check
```

To remove the service later:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm run uninstall:service
```

To restart the service after an update or `.env` change:

```powershell
npm run restart:service
```

The manual `scripts\start-healthflow-offline.cmd` launcher is only a backup for technician recovery or testing. Cashiers should use the desktop shortcut and should not need PowerShell for daily operation.

Normal cashier flow after installation:

```text
Laptop turns on
Windows starts HealthFlowOfflineServer automatically
HealthFlow offline POS is available at http://localhost:4780
Cashier opens the HealthFlow Offline POS desktop shortcut
Sales, local SQLite storage, and background sync work without PowerShell
```

PowerShell is only needed for technician/admin work: first installation, updates, restart, uninstall, firewall setup, and troubleshooting.

## 18. Configure Cashier/Staff Computers

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

## 19. Final Acceptance Test

Run these before handing over:

```text
Login as admin
Create or confirm staff accounts
Open a shift
Pull inventory to local branch server
Search for a drug in POS
Complete a cash sale
Print receipt
Confirm local stock reduced
Run Sync Now
Confirm sale appears in cloud reports
Disconnect internet
Confirm Cash sale can still be saved
Confirm Mobile Money/Card are disabled while offline
Reconnect internet
Confirm sync worker sends pending sales
If Paystack/Hubtel enabled, run one test payment
Confirm webhook marks sale paid before cloud sync
If NHIA enabled, save one NHIA claim sale
Confirm ClaimIT/NHIA fields are complete
```

PowerShell sync status check:

```powershell
$token = "<BRANCH_SERVER_TOKEN_FROM_ENV>"

Invoke-WebRequest `
  -Uri "http://192.168.1.10:4780/api/sync/status" `
  -Headers @{ "x-branch-token" = $token } `
  -UseBasicParsing
```

## 20. Updating An Existing Branch Server

Run this on the branch server computer:

```powershell
cd "C:\HealthFlowPharmacy"
git pull origin main
npm install
npm.cmd run build
npm.cmd run build:offline

cd "C:\HealthFlowPharmacy\local-branch-server"
npm install
```

Restart the service:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm run restart:service
```

If service restart is blocked, reboot the branch server computer.

## 21. Troubleshooting Commands

Check app build:

```powershell
cd "C:\HealthFlowPharmacy"
npm.cmd run build
```

Check offline bundle build:

```powershell
cd "C:\HealthFlowPharmacy"
npm.cmd run build:offline
```

Check tests:

```powershell
cd "C:\HealthFlowPharmacy"
npm.cmd run test
```

Check branch server syntax:

```powershell
cd "C:\HealthFlowPharmacy"
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

Check branch server logs:

```powershell
Get-Content "C:\HealthFlowPharmacy\logs\offline-server.log" -Tail 80
Get-Content "C:\HealthFlowPharmacy\logs\offline-server-error.log" -Tail 80
```

If `better-sqlite3` fails after changing Node versions:

```powershell
cd "C:\HealthFlowPharmacy\local-branch-server"
npm rebuild better-sqlite3
```

Check Git status before pushing:

```powershell
cd "C:\HealthFlowPharmacy"
git status
```

## 22. Onboarding Record Template

Keep this for every facility:

```text
Facility Name:
Facility Type:
Organization ID:
Main Branch ID:
Admin Name:
Admin Email:
Admin Phone:
Plan:
Enabled Modules:
Number of Branches:
Number of Staff:
Logo Uploaded: Yes/No
Receipt Configured: Yes/No
Starting Inventory Imported: Yes/No
NHIA Enabled: Yes/No
NHIA Facility Code:
NHIA Provider Number:
NHIA Provider Class/Level:
Claims Officer Name:
Claims Officer Signature Uploaded: Yes/No
Payment Providers Enabled: None/Paystack/Hubtel/Both
Paystack Webhook Configured: Yes/No
Hubtel Webhook Configured: Yes/No
Branch Server Required: Yes/No
Branch Server Computer Name:
Branch Server Install Path:
Branch Server LAN IP:
Branch Server URL:
Public Payment Webhook URL:
Branch Sync Client Registered: Yes/No
Firewall Opened: Yes/No
NSSM Service Installed: Yes/No
Final Cash Sale Test Passed: Yes/No
Final Offline Cash Test Passed: Yes/No
Final Online Payment Test Passed: Yes/No
Final NHIA Test Passed: Yes/No
Setup Date:
Installed By:
Training Completed: Yes/No
Notes:
```

Keep tokens and provider credentials in a password manager or secure admin record. Do not store live tokens in public documents.
