# HealthFlow Services

HealthFlow is a multi-tenant hospital, clinic, hospital-pharmacy, and community
pharmacy operations platform. Facility data is isolated by organization and
branch, with role-based access and audit controls.

## Core application services

### Pharmacy and inventory

- Medicine, batch, expiry, pricing, supplier, purchase, and stock management
- POS sales, shifts, receipts, payment methods, and stock movements
- Excel inventory import and e-pharmacy stock publication
- Recoverable inventory deletion through Recycle Bin

### Patients and clinical operations

- Patient registration, search, visit history, and insurance identifiers
- Patient-care records, follow-ups, refills, and clinical workflow support
- Hospital, clinic, hospital-pharmacy, and community-pharmacy configurations

### Claims and NHIS

- General insurance claims and receivables
- NHIS member lookup, CCC/CC support, patient records, medicine claims,
  attachments, audit history, and CLAIM-it/CXF workflows
- Separate Claims Officer and MCA workflow
- Draft saving, dispensary dispatch, or Claims Officer direct serving
- Pharmacy-level medicine restrictions and hospital G-DRG/tariff services
- Recoverable NHIS claim deletion and administrator-controlled permanent purge

### Reporting and accounting

- Sales, inventory, purchasing, claims, NHIS, staff-activity, receivables, and
  audit reports
- Cashbook and insurer/NHIS payment tracking
- Server-side accounting aggregation for large sales histories

### E-Pharmacy

- Licensed inter-facility stock publication
- Public customer storefront
- OTC, prescription-review, pickup, and delivery workflows
- Restricted medicine publication controls

## Local Branch Server services

- Local SQLite operation and durable synchronization outbox
- Offline POS and supported facility workflows
- Facility-wide HTTPS LAN operation
- Automated Windows installation, service registration, TLS certificate
  generation, firewall configuration, renewal, and workstation enrollment
- One offline PIN per user stored as a salted scrypt hash on the facility server
- Rate limiting, lockout, local authentication audit, and admin revoke/reset
- Signed branch-server updates with rollback
- Local CLAIM-it bridge and NHIA integration support

## Platform and deployment services

- Facility onboarding, branding, branches, staff, roles, and privileges
- Supabase PostgreSQL, Auth, RLS, storage, RPCs, and Edge Functions
- Vercel-hosted web application and automated Git deployment
- Production health monitoring, backups, restore procedures, and audit tooling

## Security boundaries

- No Supabase/cloud passwords are copied into offline authentication.
- Backend credentials and certificates are never hardcoded.
- Tenant tables and privileged mutations are organization-scoped.
- Facility LAN access requires trusted TLS; otherwise the server stays
  loopback-only.
- Sensitive deletion and recovery controls are administrator-only.

## Service limitations

- Official NHIA/CLAIM-it connectivity depends on credentials and endpoints
  issued or approved for the facility.
- Supported offline features depend on the Local Branch Server and current sync
  coverage.
- HealthFlow is not described as fully end-to-end encrypted because authorized
  backend services must process operational data for search and reporting.

