# Multi-Tenant Migration Guide

This guide provides step-by-step instructions for transforming HealthFlow Pharmacy from a single-tenant application to a multi-tenant SaaS platform.

## Overview

The multi-tenant architecture uses:
- **Shared database** with Row-Level Security (RLS) for data isolation
- **Organization-based tenancy** where each pharmacy is an organization
- **Subdomain identification** (e.g., `abc-pharmacy.healthflow.app`)
- **Trial and subscription tiers** with usage tracking

## Architecture Components

### 1. Database Layer
- `organizations` table: Stores pharmacy tenant information
- `organization_id` column: Added to all tables for data isolation
- **RLS Policies**: Automatically filter data by organization
- **Helper Function**: `public.user_organization_id()` returns current user's organization

### 2. Backend Services
- `organizationService.js`: CRUD operations for organizations
- Updated authentication flow with organization context

### 3. Frontend Components
- `AuthContext`: Extended to include organization data
- `TenantContext`: Provides organization-level utilities
- `Signup.jsx`: Multi-step onboarding flow for new pharmacies
- Settings page: Organization management UI

### 4. Database Helper Function
- `public.user_organization_id()`: Returns current user's organization ID
- Used in all RLS policies for automatic tenant filtering

## Migration Steps

### Step 1: Run Database Migrations

**IMPORTANT**: Run migrations in Supabase SQL Editor in this exact order:

#### A. Run Step 1 Migration (Schema Changes)

1. Open Supabase Dashboard → SQL Editor
2. Copy contents of `supabase-migration-multi-tenant-step1.sql`
3. Execute the entire script
4. Verify success with these queries:

```sql
-- Check organizations table exists
SELECT * FROM organizations;

-- Check organization_id column added to tables
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name = 'organization_id';

-- Verify default organization created
SELECT * FROM organizations WHERE subdomain = 'healthflow';

-- Check existing data migrated
SELECT organization_id, COUNT(*) 
FROM users 
GROUP BY organization_id;
```

**Expected Results**:
- 1 organization with subdomain 'healthflow' should exist
- All existing users, drugs, patients, sales should have `organization_id` set
- No NULL values in `organization_id` columns

#### B. Run Step 2 Migration (RLS Policies)

1. After Step 1 completes successfully, run `supabase-migration-multi-tenant-step2-rls.sql`
2. This will:
   - Create the `public.user_organization_id()` helper function
   - Drop old single-tenant RLS policies
   - Create new multi-tenant RLS policies with organization filtering

3. Verify with:

```sql
-- List all RLS policies
SELECT schemaname, tablename, policyname 
FROM pg_policies 
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- Test the helper function
SELECT public.user_organization_id();
```

**Expected Results**:
- All tables should have new policies with `_same_org` or `_own` suffixes
- The helper function should return your organization ID when called as authenticated user

### Step 2: Deploy Frontend Code

The frontend changes are already implemented. Deploy to Vercel:

```powershell
npm run build
git add .
git commit -m "Implement multi-tenant architecture"
git push origin main
```

Vercel will automatically deploy the changes.

### Step 3: Update Environment Variables

No additional environment variables needed. The existing Supabase credentials work.

### Step 4: Test Multi-Tenant Functionality

#### A. Test Existing Users

1. Login with existing credentials
2. Verify you can see your existing data (drugs, patients, sales)
3. Go to Settings → Organization tab
4. Verify organization shows: "healthflow" subdomain, "Trial" status

#### B. Test New Pharmacy Signup

1. Logout
2. Go to `/signup`
3. Fill in pharmacy information:
   - Pharmacy Name: "Test Pharmacy"
   - Subdomain: "test-pharmacy" (must be unique)
   - Contact details
4. Create admin account
5. Verify successful registration
6. Login with new account
7. Verify empty data (no drugs, patients, sales from other orgs)

#### C. Test Data Isolation

1. As "healthflow" admin: Create a drug called "Paracetamol A"
2. Logout and login as "test-pharmacy" admin
3. Go to Inventory
4. Verify "Paracetamol A" is NOT visible
5. Create a drug "Paracetamol B"
6. Logout and login back as "healthflow" admin
7. Verify "Paracetamol B" is NOT visible

**If you can see other organization's data, RLS is not working correctly. Check Step 1B again.**

### Step 5: Configure Organization Owner

After migration, the default organization needs an owner. Run in Supabase SQL Editor:

```sql
-- Set the current admin as organization owner
UPDATE organizations 
SET owner_user_id = (
  SELECT id FROM users 
  WHERE email = 'your-admin-email@example.com' 
  AND organization_id = organizations.id
  LIMIT 1
)
WHERE subdomain = 'healthflow';
```

Replace `your-admin-email@example.com` with your actual admin email.

## Post-Migration Tasks

### 1. Update Domain Configuration (Optional)

To use custom subdomains like `pharmacy-name.healthflow.app`:

1. Add wildcard DNS record: `*.healthflow.app` → Your Vercel deployment
2. Update Vercel: Add `*.healthflow.app` to custom domains
3. Implement subdomain routing logic in `App.jsx` (future enhancement)

### 2. Setup Subscription Management (Future)

Consider integrating:
- Stripe for payments
- Subscription tier enforcement (basic, professional, enterprise)
- Usage limits based on tier
- Automated trial expiration reminders

### 3. Monitor Organization Usage

Query to check organization growth:

```sql
SELECT 
  o.name,
  o.subdomain,
  o.status,
  o.subscription_tier,
  o.trial_ends_at,
  COUNT(DISTINCT u.id) as total_users,
  COUNT(DISTINCT d.id) as total_drugs,
  COUNT(DISTINCT s.id) as total_sales
FROM organizations o
LEFT JOIN users u ON u.organization_id = o.id
LEFT JOIN drugs d ON d.organization_id = o.id
LEFT JOIN sales s ON s.organization_id = o.id
GROUP BY o.id, o.name, o.subdomain, o.status, o.subscription_tier, o.trial_ends_at
ORDER BY o.created_at DESC;
```

## Troubleshooting

### Issue: "new row violates row-level security policy"

**Cause**: User doesn't have an organization_id or RLS policies not updated

**Solution**:
```sql
-- Check user's organization
SELECT id, email, organization_id FROM users WHERE email = 'user@example.com';

-- If organization_id is NULL:
UPDATE users 
SET organization_id = (SELECT id FROM organizations LIMIT 1)
WHERE email = 'user@example.com';
```

### Issue: Can see other organization's data

**Cause**: RLS policies not applied correctly

**Solution**:
1. Re-run `supabase-migration-multi-tenant-step2-rls.sql`
2. Verify policies exist:
```sql
SELECT * FROM pg_policies WHERE tablename = 'drugs';
```

### Issue: Subdomain already taken error

**Cause**: Subdomain conflict in organizations table

**Solution**:
```sql
-- Check existing subdomains
SELECT subdomain FROM organizations;

-- Change conflicting subdomain
UPDATE organizations 
SET subdomain = 'new-unique-subdomain' 
WHERE subdomain = 'conflicting-subdomain';
```

### Issue: Trial expired but can still access

**Cause**: Trial enforcement not implemented yet

**Solution**: Add trial expiration check in `ProtectedRoute.jsx` (future enhancement)

## Rollback Procedure

If you need to revert to single-tenant:

### Rollback Step 1: Restore Old RLS Policies

```sql
-- Drop multi-tenant policies
DROP POLICY IF EXISTS organizations_select_own ON organizations;
DROP POLICY IF EXISTS users_select_same_org ON users;
-- (Continue for all tables...)

-- Recreate original policies (copy from your backup or git history)
```

### Rollback Step 2: Keep Data, Remove Organization Columns (Optional)

**WARNING**: This will lose organization associations. Only do this if absolutely necessary.

```sql
-- Backup first!
-- Then remove organization_id columns:
ALTER TABLE users DROP COLUMN organization_id;
ALTER TABLE drugs DROP COLUMN organization_id;
-- (Continue for all tables...)

-- Drop organizations table
DROP TABLE organizations;
```

## Security Checklist

- [x] RLS enabled on all tables
- [x] `organization_id` NOT NULL constraints (after data migration)
- [x] Helper function `public.user_organization_id()` uses SECURITY DEFINER
- [x] Policies filter by `organization_id = public.user_organization_id()`
- [x] No direct SQL bypasses in frontend code
- [x] Admin users can only manage their own organization's users
- [ ] Implement rate limiting (future)
- [ ] Add audit logging for organization changes (future)

## Performance Considerations

1. **Indexes**: All `organization_id` columns are indexed (done in Step 1)
2. **Query Optimization**: Always include `organization_id` in WHERE clauses
3. **Connection Pooling**: Supabase handles this automatically
4. **Caching**: Consider caching organization settings in frontend

## Future Enhancements

1. **Super Admin Dashboard**: Manage all organizations from central dashboard
2. **Custom Branding**: Allow organizations to customize logo, colors
3. **API Access**: Provide REST API for integrations with `organization_id` scoping
4. **Advanced Analytics**: Cross-organization insights for super admins
5. **Export/Import**: Allow organizations to export their data
6. **Subdomain Routing**: Automatically detect subdomain and filter data

## Support

For issues or questions:
- **Developer**: David Gabion Selorm
- **Email**: gabiondavidselorm@gmail.com
- **Company**: Neon Digital Technologies
- **Website**: https://www.neondigitaltechnologies.com
- **Business Email**: zittechgh@gmail.com

---

## Quick Reference

### Key Files Modified

**Database**:
- `supabase-migration-multi-tenant-step1.sql` - Schema changes
- `supabase-migration-multi-tenant-step2-rls.sql` - RLS policies

**Services**:
- `src/services/organizationService.js` - New
- `src/context/AuthContext.jsx` - Updated
- `src/context/TenantContext.jsx` - New

**Pages**:
- `src/pages/Signup.jsx` - New
- `src/pages/Settings.jsx` - Updated with Organization card

**Routing**:
- `src/App.jsx` - Added `/signup` route
- `src/main.jsx` - Added TenantProvider wrapper

### Database Schema Summary

```
organizations
├── id (uuid, pk)
├── name (text)
├── subdomain (text, unique)
├── status (text: trial|active|suspended|cancelled)
├── subscription_tier (text: trial|basic|professional|enterprise)
├── owner_user_id (uuid, fk → users.id)
├── trial_ends_at (timestamp)
├── subscription_ends_at (timestamp)
├── phone, email, address, city, region, license_number
└── settings (jsonb)

All tables now have:
└── organization_id (uuid, fk → organizations.id, indexed)
```

### Policy Pattern

All tables follow this RLS pattern:

```sql
-- SELECT: View own organization's data
CREATE POLICY "tablename_select_same_org" ON tablename
FOR SELECT
USING (organization_id = public.user_organization_id());

-- INSERT: Insert only to own organization
CREATE POLICY "tablename_insert_same_org" ON tablename
FOR INSERT
WITH CHECK (organization_id = public.user_organization_id());

-- UPDATE: Update only own organization's data
CREATE POLICY "tablename_update_same_org" ON tablename
FOR UPDATE
USING (organization_id = public.user_organization_id())
WITH CHECK (organization_id = public.user_organization_id());

-- DELETE: Delete only own organization's data
CREATE POLICY "tablename_delete_same_org" ON tablename
FOR DELETE
USING (organization_id = public.user_organization_id());
```

---

**Migration completed successfully!** Your HealthFlow Pharmacy is now a multi-tenant SaaS platform. 🎉

