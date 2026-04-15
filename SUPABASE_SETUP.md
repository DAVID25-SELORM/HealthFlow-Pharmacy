# 🚀 Supabase Setup Guide for HealthFlow Pharmacy

## 📋 Step-by-Step Instructions

### Step 1: Create Supabase Account
1. Go to [https://supabase.com](https://supabase.com)
2. Click "Start your project"
3. Sign up with GitHub, Google, or email

### Step 2: Create New Project
1. Click "New Project"
2. Fill in:
   - **Project Name**: `healthflow-pharmacy`
   - **Database Password**: Create a strong password (save it!)
   - **Region**: Choose closest to Ghana (e.g., Europe West or South Africa)
3. Click "Create new project"
4. Wait 2-3 minutes for setup

### Step 3: Get Your API Credentials
1. In your project dashboard, click "Settings" (gear icon)
2. Go to "API" section
3. Copy these two values:
   - **Project URL** (looks like: `https://xxxxx.supabase.co`)
   - **Publishable key** (preferred) or **anon public key**

### Step 4: Configure Your App
1. Open the `.env` file in HealthFlow Pharmacy folder
2. Replace the placeholder values:
```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxx
# Optional legacy support:
# VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Step 5: Create Database Tables
1. In Supabase dashboard, click "SQL Editor" (left sidebar)
2. Click "New query"
3. Open the `supabase-schema.sql` file from your project
4. Copy ALL the content
5. Paste it into the Supabase SQL Editor
6. Click "Run" (or press F5)
7. Wait for success message ✅

### Existing Project Upgrade (Important)

If your project already has tables from an earlier setup, do not rerun the full schema blindly.

1. Open `supabase-migration-2026-04-14.sql`
2. Run it in SQL Editor
3. This migration adds:
   - RLS policies and numeric constraints (idempotent checks)
   - Atomic transaction RPCs (`create_sale_transaction`, `create_claim_transaction`)
   - Execute grants for authenticated role

### Step 6: Verify Tables Created
1. Click "Table Editor" in Supabase sidebar
2. You should see these tables:
   - ✅ users
   - ✅ drugs
   - ✅ patients
   - ✅ sales
   - ✅ sale_items
   - ✅ claims
   - ✅ claim_items
   - ✅ stock_movements
   - ✅ pharmacy_settings

### Step 7: Restart Your App
1. Stop the development server (Ctrl+C in terminal)
2. Run `npm run dev` again
3. Your app is now connected to Supabase! 🎉

## 🔒 Security Notes

### Important: Add .env to .gitignore
Your `.env` file is already in `.gitignore` to protect your credentials.

### Never Commit Real Credentials
- Use `.env.example` for sharing template
- Keep `.env` with real values private

## 📊 Database Schema Overview

### Core Tables:
- **users** - System users (admin, pharmacist, assistant)
- **drugs** - Inventory management
- **patients** - Patient records
- **sales** - Transaction records
- **sale_items** - Individual items in each sale
- **claims** - Insurance claims
- **claim_items** - Drugs in each claim
- **stock_movements** - Audit trail for inventory changes
- **pharmacy_settings** - System configuration

### Automatic Features:
- 📉 Auto-updates drug quantity when sold
- 🔢 Auto-generates sale/claim numbers
- 📊 Pre-built views for reports (low stock, expiring drugs, etc.)

## 🧪 Testing the Connection

After setup, test by:
1. Going to Inventory page
2. Adding a new drug
3. Check Supabase Table Editor - it should appear!

## ❓ Troubleshooting

### "Supabase credentials not configured"
- Make sure `.env` file has NO spaces around `=`
- Restart dev server after changing `.env`
- Check for typos in URL or key

### "Failed to fetch" or CORS errors
- Verify Project URL is correct (should start with `https://`)
- Make sure you copied the **anon** key, not the service_role key

### Tables not created
- Re-run the SQL script
- Check SQL Editor for error messages
- Make sure you copied the ENTIRE schema file

## 🎯 Next Steps

After Supabase is connected:
1. ✅ Test adding drugs
2. ✅ Test making sales
3. ✅ Test creating claims
4. Add authentication (login system)
5. Deploy to Vercel

## 💡 Free Tier Limits

Supabase Free Plan includes:
- ✅ 500 MB database
- ✅ 1 GB file storage
- ✅ 2 GB bandwidth
- ✅ Unlimited API requests

Perfect for testing and 5-10 pharmacies!

---

**Need help?** Contact David Gabion Selorm
- Email: gabiondavidselorm@gmail.com
- Business: zittechgh@gmail.com
