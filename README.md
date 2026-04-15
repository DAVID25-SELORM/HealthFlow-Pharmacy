# HealthFlow Pharmacy Management System

A modern pharmacy management system for efficient drug inventory, sales, patient records, and insurance claims management.

## Features

- 💊 **Drug Inventory Management** - Track stock levels, batch numbers, and expiry dates
- 📤 **Excel Import** - Bulk import drugs from Excel files ([See Guide](DRUG_IMPORT_GUIDE.md))
- 🧾 **Sales & POS** - Quick dispensing with cash, mobile money, and insurance support
- 🏥 **Insurance Claims** - Automated claim tracking and submission
- 👥 **Patient Records** - Manage patient information and prescription history
- 📊 **Reports & Analytics** - Daily sales, monthly trends, and insights
- 🔐 **User Roles** - Admin, Pharmacist, and Assistant access levels

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

📋 **See [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md)** for complete deployment guide including:
- Supabase database setup
- First admin user creation
- Edge function deployment
- Environment variable configuration
- Production smoke tests

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
