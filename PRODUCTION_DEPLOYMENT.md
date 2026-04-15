# 🚀 Production Deployment Checklist - HealthFlow Pharmacy

**Deployment Date**: April 15, 2026  
**Developer**: David Gabion Selorm  
**Live URL**: https://health-flow-pharmacy.vercel.app

---

## ✅ Pre-Deployment Status

### Frontend (Vercel)
- ✅ **Build**: Passes (10.82s, 445KB bundle)
- ✅ **Tests**: All pass (4/4 validation tests)
- ✅ **Deployment**: Live and accessible
- ✅ **Environment**: Production variables set in Vercel

### Backend (Supabase)
- ⚠️ **Database Schema**: Requires setup (see below)
- ⚠️ **First Admin User**: Must be created manually
- ⚠️ **Edge Functions**: Must be deployed
- ⚠️ **Environment Variables**: Must be configured

---

## 📋 Step-by-Step Deployment Guide

### Step 1: Supabase Project Setup

1. **Go to**: [https://supabase.com/dashboard](https://supabase.com/dashboard)
2. **Create/Select Project**: `healthflow-pharmacy`
3. **Note Project Details**:
   - Project URL: `https://[your-project-id].supabase.co`
   - Anon/Public Key: From Settings → API
   - Service Role Key: From Settings → API (keep secret!)

### Step 2: Run Database Schema

**For New Projects** (no existing tables):

1. Open Supabase SQL Editor
2. Paste contents of `supabase-schema.sql`
3. Click **Run** (F5)
4. Verify all tables created in Table Editor

**For Existing Projects** (already has base tables):

1. Open Supabase SQL Editor
2. Paste contents of `supabase-migration-2026-04-14.sql`
3. Click **Run** (F5)
4. Confirms idempotent - safe to re-run

### Step 3: Create First Admin User

**Option A: Via Supabase Dashboard** (Recommended)

1. Go to **Authentication → Users**
2. Click **Add user** → **Create new user**
3. Fill in:
   - Email: `admin@healthflow.com` (or your admin email)
   - Password: [Strong password - save it!]
   - Email confirmation: ✅ Skip (mark as confirmed)
   - User Metadata:
     ```json
     {
       "full_name": "David Gabion Selorm",
       "role": "admin"
     }
     ```
   - App Metadata:
     ```json
     {
       "role": "admin"
     }
     ```
4. Click **Create user**
5. **Copy the User ID** (looks like: `3fa85f64-5717-4562-b3fc-2c963f66afa6`)

**Option B: Via SQL** (After creating auth user above)

After creating the auth user, run this SQL (replace `USER_ID_HERE` and `ADMIN_EMAIL_HERE`):

```sql
INSERT INTO public.users (id, email, full_name, role, is_active)
VALUES (
  'USER_ID_HERE'::UUID,
  'ADMIN_EMAIL_HERE',
  'David Gabion Selorm',
  'admin',
  true
)
ON CONFLICT (id) DO UPDATE
SET 
  email = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  role = EXCLUDED.role,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
```

**⚠️ CRITICAL**: The UUID in both `auth.users` and `public.users` MUST match!

### Step 4: Deploy Edge Function (staff-admin)

**Prerequisites**:
- Supabase CLI installed: `npm install -g supabase`
- Logged in: `supabase login`

**Deploy Commands**:

```powershell
# Link to your project (first time only)
supabase link --project-ref [your-project-id]

# Deploy the staff-admin function
supabase functions deploy staff-admin

# Set environment variables for the function
supabase secrets set SERVICE_ROLE_KEY=[your-service-role-key]
```

**Verify Deployment**:
1. Go to Supabase Dashboard → Edge Functions
2. Confirm `staff-admin` appears and is deployed
3. Check logs for any errors

### Step 5: Configure Vercel Environment Variables

**In Vercel Dashboard** (Settings → Environment Variables):

| Variable | Value | Source |
|----------|-------|--------|
| `VITE_SUPABASE_URL` | `https://[project-id].supabase.co` | Supabase Settings → API |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `eyJ...` | Supabase Settings → API (anon key) |

**After adding variables**:
- Redeploy the Vercel project to pick up new environment variables

### Step 6: Production Smoke Test

**Test as Admin User**:

1. ✅ **Login**: 
   - Go to https://health-flow-pharmacy.vercel.app
   - Sign in with admin credentials
   - Verify redirect to dashboard

2. ✅ **Create Staff User** (Tests Edge Function):
   - Navigate to Settings
   - Fill out "Staff Onboarding" form
   - Create a test pharmacist or assistant
   - Verify success message

3. ✅ **Add Drug** (Tests Inventory RLS):
   - Navigate to Inventory
   - Add a test drug with batch, expiry, price
   - Verify it appears in inventory list

4. ✅ **Create Patient**:
   - Navigate to Patients
   - Add a test patient
   - Verify patient appears in list

5. ✅ **Make Sale** (Tests Transaction RPC):
   - Navigate to Sales
   - Create a sale with test drug
   - Verify sale completes and stock decreases

6. ✅ **Create Claim** (Tests Claims RPC):
   - Navigate to Claims
   - Create an insurance claim
   - Verify claim appears with "pending" status

7. ✅ **View Reports**:
   - Navigate to Reports
   - Verify daily sales, top drugs, low stock alerts display

8. ✅ **Staff Sign-In Test**:
   - Sign out
   - Sign in as the staff user created in step 2
   - Verify role-based access (assistants can't access Inventory/Claims)

---

## 🔒 Security Checklist

- ✅ Row Level Security (RLS) enabled on all tables
- ✅ Role-based policies implemented (admin/pharmacist/assistant)
- ✅ Service role key stored securely (Supabase secrets, not in .env)
- ✅ Auth tokens auto-refresh enabled
- ✅ Numeric constraints prevent negative quantities/prices
- ✅ Audit logging tracks sensitive operations
- ⚠️ **Action Required**: Disable auth user creation in Supabase Auth settings (Dashboard → Authentication → Providers → Email → Disable sign-ups)

---

## 📊 Monitoring & Maintenance

### Daily Checks
- Monitor Supabase Dashboard → Database → Usage
- Check Edge Function logs for errors
- Review audit logs for suspicious activity

### Weekly Maintenance
- Review pharmacy_settings for accuracy
- Check for drugs nearing expiry
- Verify low stock alerts are working

### Monthly Tasks
- Backup database (Supabase → Database → Backups)
- Review user access and roles
- Check for Supabase/Vercel updates

---

## 🆘 Troubleshooting

### "Supabase credentials not configured"
- Verify environment variables in Vercel
- Redeploy after adding variables
- Clear browser cache

### "You don't have permission"
- Check user role in `public.users` table
- Verify RLS policies are applied
- Check `app_metadata` and `user_metadata` in auth.users

### "Failed to create staff user"
- Verify `staff-admin` function is deployed
- Check function logs in Supabase Dashboard
- Confirm `SERVICE_ROLE_KEY` secret is set

### Login fails for admin
- Verify admin exists in both `auth.users` AND `public.users`
- Check `is_active = true` in `public.users`
- Verify email matches in both tables

---

## 🎯 Production Readiness Checklist

Before announcing to users:

- [ ] All 6 smoke tests above pass ✅
- [ ] First admin user can log in
- [ ] Staff user creation works
- [ ] Sales transactions complete successfully
- [ ] Claims submission works
- [ ] Reports display data correctly
- [ ] Password reset email works (test forgot password)
- [ ] Mobile responsiveness verified
- [ ] Backup strategy documented
- [ ] Support contact information added to Settings

---

## 📞 Support & Contact

**Developer**: David Gabion Selorm  
**Email**: gabiondavidselorm@gmail.com  
**Business**: zittechgh@gmail.com  
**Phone**: +233247654381

---

**Last Updated**: April 15, 2026  
**Version**: 1.0.0  
**Status**: 🟡 Pre-Production (Awaiting Supabase Setup)
