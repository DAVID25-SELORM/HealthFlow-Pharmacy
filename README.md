# HealthFlow Pharmacy Management System

A modern **multi-tenant SaaS** pharmacy management system for efficient drug inventory, sales, patient records, and insurance claims management. Each pharmacy operates as an isolated organization with its own data and users.

## Features

- 🏢 **Multi-Tenant Architecture** - Serve multiple pharmacies with complete data isolation ([See Migration Guide](MULTI_TENANT_MIGRATION_GUIDE.md))
- 📝 **Pharmacy Onboarding** - Self-service signup with 30-day free trial
- 💊 **Drug Inventory Management** - Track stock levels, batch numbers, and expiry dates
- 📤 **Excel Import** - Bulk import drugs from Excel files ([See Guide](DRUG_IMPORT_GUIDE.md))
- 🧾 **Sales & POS** - Quick dispensing with cash, mobile money, and insurance support
- 🖨️ **Receipt Printing** - Professional receipts with browser print & PDF export ([See Guide](RECEIPT_PRINTING_GUIDE.md))
- 🏥 **Insurance Claims** - Automated claim tracking and submission
- 👥 **Patient Records** - Manage patient information and prescription history
- 📊 **Reports & Analytics** - Daily sales, monthly trends, and insights
- 🔐 **User Roles** - Admin, Pharmacist, and Assistant access levels
- 🌐 **Organization Management** - Subdomain support, subscription tiers, usage tracking

## Tech Stack

- React + Vite
- React Router
- Supabase (Backend & Database)
- Lucide Icons

## Getting Started

### Development

1. Install dependencies:
```bash
npm install
```

2. Run development server:
```bash
npm run dev
```

3. Build for production:
```bash
npm run build
```

4. Run tests:
```bash
npm run test
```

### Production Deployment

📋 **Multi-Tenant Deployment**:
- [MULTI_TENANT_MIGRATION_GUIDE.md](MULTI_TENANT_MIGRATION_GUIDE.md) - Complete guide for transforming to multi-tenant
- [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md) - Vercel deployment guide
- [SUPABASE_SETUP.md](SUPABASE_SETUP.md) - Database setup instructions

**Quick Start for Multi-Tenant**:
1. Run database migrations in order:
   - `supabase-migration-multi-tenant-step1.sql` (schema changes)
   - `supabase-migration-multi-tenant-step2-rls.sql` (RLS policies)
2. Deploy frontend to Vercel
3. Test with existing account (migrated to default 'healthflow' organization)
4. Create new pharmacy via `/signup` route

**Architecture**:
- **Shared Database**: All tenants in one PostgreSQL database
- **RLS Isolation**: Row-Level Security ensures perfect data separation
- **Organization-Based**: Every table has `organization_id` for tenant filtering
- **Automatic Filtering**: All queries automatically scoped to user's organization

## Quality Gates

- Unit tests: `npm run test`
- Coverage: `npm run test:coverage`
- CI workflow: `.github/workflows/ci.yml` runs tests and build on push/PR to `main`

## Developer

Built by **David Gabion Selorm**
- Email: gabiondavidselorm@gmail.com
- Business: zittechgh@gmail.com

---
© 2026 HealthFlow Pharmacy. All rights reserved.
