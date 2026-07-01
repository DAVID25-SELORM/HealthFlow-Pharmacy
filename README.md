# HealthFlow

HealthFlow is a multi-tenant platform for pharmacy, claims, NHIS, inventory, tariffs, local sync, and facility operations. The master brand is **HealthFlow**; facility-facing screens use each facility's own name, logo, and document branding.

## Brand Architecture

- **HealthFlow** - master platform for facility operations.
- **Pharmacy module** - dispensing, POS, inventory, medicines, and pharmacy workflows.
- **HealthFlow Claims** - NHIA/NHIS claims preparation, tracking, and export.
- **HealthFlow NHIS** - member verification, CCC generation, NHIS patient records, and claims support.
- **HealthFlow Inventory** - medicine catalog, branch stock, expiry, and replenishment workflows.
- **HealthFlow Tariffs** - G-DRG tariff and medicines pricing support.
- **HealthFlow Branch Server** - local SQLite, offline POS, local sync, and CLAIM-it bridge operations.

## Supported Facilities

HealthFlow supports:

- Community Pharmacy
- Hospital Pharmacy
- Clinic
- Hospital

Facility criteria remain separated:

- Pharmacy: P1, P2, LCS, HP
- Hospital: B1, B2, C, D, M, SM

## Features

- **Multi-tenant architecture** - multiple facilities with isolated organization data.
- **Facility onboarding** - self-service signup with trial setup.
- **Inventory management** - stock levels, batch numbers, expiry dates, cost, and selling prices.
- **Recoverable deletion** - administrator Recycle Bin for inventory items and NHIS claims.
- **Excel import** - bulk import medicines from Excel files.
- **Sales and POS** - cash, mobile money, insurance, and NHIA claim flows.
- **Receipt printing** - professional receipts with browser print and PDF export.
- **NHIS and claims** - NHIA member checks, CCC support, draft/dispatch/direct-serving workflows, prescription attachments, G-DRG/tariff workflows, and CLAIM-it exports. Direct NHIS serving bypasses MCA and does not change inventory.
- **Patient records** - standard patients and NHIS patient lists.
- **Reports and analytics** - sales, claims, inventory, and operational insights.
- **Role-based access** - admin, pharmacist, claims officer, cashier, MCA, and other role levels.
- **Branch server** - local SQLite, facility-wide offline PINs, trusted HTTPS LAN access, background cloud sync, signed updates, and CLAIM-it bridge support.
- **Licensed E-Pharmacy** - inter-facility stock sharing plus a public customer storefront with progressive OTC and prescription checkout.

## Customer E-Pharmacy

The public customer storefront is available at:

```text
/shop
```

Customers may browse published stock without signing in. Checkout requires a
Supabase Auth account:

- Google and Apple use Supabase OAuth.
- Yahoo and other email providers use Supabase email magic links.
- OTC pickup requires a verified account, full name, mobile number, terms, and
  privacy consent.
- Delivery additionally requires delivery address details.
- Prescription orders additionally require identity details, patient details,
  allergies/current medicines, a private prescription upload, and pharmacist
  review.
- Restricted, controlled, and narcotic medicines remain blocked from online
  publication and ordering.

Apply `20260612123000_customer_epharmacy_portal.sql`, then deploy:

```bash
npx supabase functions deploy customer-epharmacy
npx supabase functions deploy tier-access
```

In Supabase Auth, add `/shop` to the redirect allow-list and enable the Google
and Apple providers with credentials issued by those providers. OAuth secrets
must remain in Supabase and must not be committed to this repository.

## Tech Stack

- React + Vite
- React Router
- Supabase
- SQLite local branch server
- Lucide Icons

## Getting Started

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Build the offline branch-server bundle:

```bash
npm run build:offline
```

Run tests:

```bash
npm run test
```

## Production Deployment

Use these guides for production setup:

- [Deployment and readiness](docs/DEPLOYMENT.md)
- [Complete user manual](docs/USER_MANUAL.md)
- [HealthFlow services](docs/SERVICES.md)
- [Branch server guide](docs/BRANCH_SERVER_GUIDE.md)
- [Multi-tenant migration history](docs/MULTI_TENANT_HISTORY.md)
- [Drug import guide](docs/DRUG_IMPORT.md)
- [Receipt printing guide](docs/RECEIPT_PRINTING.md)
- [SUPABASE_SETUP.md](SUPABASE_SETUP.md)
- [BACKUP_AND_RECOVERY.md](BACKUP_AND_RECOVERY.md)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

Quick start for multi-tenant setup:

1. Run database migrations in order.
2. Deploy Supabase Edge Functions such as `staff-admin`, `tenant-signup`, `tier-access`, and `customer-epharmacy`.
3. Deploy the frontend to Vercel or the selected hosting platform.
4. Register each facility and branch.
5. Install the HealthFlow Branch Server where local/offline sync is required.

## Vercel CLAIM-it Bridge

The production CLAIM-it/NHIA bridge for this deployment is served at:

```text
https://healthflowcloud.com/json-api
```

If `claimbridge.healthflowgh.com` is added as a Vercel custom domain for this project, the same bridge is available at:

```text
https://claimbridge.healthflowgh.com/json-api
```

Set these Vercel environment variables:

```env
CLAIMIT_UPSTREAM_BASE_URL=https://official-claimit-or-nhia-host.example.com
CLAIM_BRIDGE_TOKEN=<long-random-production-token>
CLAIM_BRIDGE_TOKEN_HEADER=x-claim-bridge-token
```

Optional upstream auth variables:

```env
CLAIMIT_UPSTREAM_API_KEY=
CLAIMIT_UPSTREAM_API_KEY_HEADER=x-api-key
CLAIMIT_UPSTREAM_API_SECRET=
CLAIMIT_UPSTREAM_API_SECRET_HEADER=x-api-secret
CLAIMIT_UPSTREAM_BEARER_TOKEN=
CLAIMIT_UPSTREAM_USERNAME=
CLAIMIT_UPSTREAM_PASSWORD=
```

Health check:

```text
/json-api/health
```

## Quality Gates

- Lint: `npm run lint`
- Unit tests: `npm run test`
- Coverage: `npm run test:coverage`
- Build: `npm run build`
- Offline bundle: `npm run build:offline`

## Developer

Built by **David Gabion Selorm**

- Email: gabiondavidselorm@gmail.com
- Business: Neon Digital Technologies
- Website: https://www.neondigitaltechnologies.com
- Business Email: zittechgh@gmail.com

---

Copyright 2026 HealthFlow. All rights reserved.
