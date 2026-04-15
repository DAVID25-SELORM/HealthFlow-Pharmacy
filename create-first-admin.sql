-- ================================================
-- FIRST ADMIN USER SETUP - TEMPLATE
-- ================================================
-- ⚠️ WARNING: THIS IS A TEMPLATE FILE ⚠️
-- DO NOT RUN THIS FILE AS-IS! It will fail.
-- You MUST replace the placeholder values below with your actual data.
-- ================================================

-- ============================================
-- STEP 1: Create Auth User via Supabase Dashboard FIRST!
-- ============================================
-- 1. Go to: Dashboard → Authentication → Users → Add User
-- 2. Fill in these fields:
--    - Email: your-admin@email.com
--    - Password: [Create a strong password and SAVE IT!]
--    - Auto Confirm User: ✅ YES (check this box)
--    - User Metadata (click "Add Field" twice):
--      * Key: full_name  →  Value: Your Full Name
--      * Key: role       →  Value: admin
-- 3. Click "Create User"
-- 4. **COPY THE USER ID** from the user list (looks like: 3fa85f64-5717-4562-b3fc-2c963f66afa6)
-- 5. Come back here and replace the values below

-- ============================================
-- STEP 2: Replace These Values Below
-- ============================================
-- Find and replace these THREE placeholders:
-- 1. AUTH_USER_ID_HERE → Paste the UUID you copied from Supabase Dashboard
-- 2. ADMIN_EMAIL_HERE → Type the exact email you used above
-- 3. Update full_name and phone with your actual details

-- ============================================
-- STEP 3: Run This SQL (After Replacing Values)
-- ============================================

INSERT INTO public.users (id, email, full_name, phone, role, is_active)
VALUES (
  'AUTH_USER_ID_HERE',         -- ⚠️ REPLACE THIS with UUID from Dashboard
  'ADMIN_EMAIL_HERE',          -- ⚠️ REPLACE THIS with your admin email
  'David Gabion Selorm',       -- Update with your full name
  '+233247654381',             -- Update with your phone number
  'admin',                     -- Leave as 'admin'
  true                         -- Leave as true
)
ON CONFLICT (id) DO UPDATE
SET 
  email = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  phone = EXCLUDED.phone,
  role = EXCLUDED.role,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- ============================================
-- STEP 4: Verify Setup (Run This Query)
-- ============================================

SELECT 
  u.id,
  u.email,
  u.full_name,
  u.role,
  u.is_active,
  au.email_confirmed_at,
  au.created_at
FROM public.users u
LEFT JOIN auth.users au ON u.id = au.id
WHERE u.role = 'admin';

-- ✅ Expected Result:
-- - Should show your admin user
-- - is_active = true
-- - email_confirmed_at should have a timestamp (not NULL)
-- - Both emails should match exactly

-- ============================================
-- STEP 5: Test Login
-- ============================================
-- Go to: https://health-flow-pharmacy.vercel.app
-- Sign in with the email and password you created
-- You should be redirected to the Dashboard

-- ================================================
-- EXAMPLE (DO NOT RUN AS-IS)
-- ================================================
/*
-- Example with real values (yours will be different):
INSERT INTO public.users (id, email, full_name, phone, role, is_active)
VALUES (
  '3fa85f64-5717-4562-b3fc-2c963f66afa6'::UUID,
  'admin@healthflow.com',
  'David Gabion Selorm',
  '+233247654381',
  'admin',
  true
)
ON CONFLICT (id) DO UPDATE
SET 
  email = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  phone = EXCLUDED.phone,
  role = EXCLUDED.role,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();
*/

-- ================================================
-- TROUBLESHOOTING
-- ================================================

-- If you can't log in after creating the user:

-- 1. Check if user exists in both tables
SELECT 'auth.users' as table_name, id, email, email_confirmed_at 
FROM auth.users 
WHERE email = 'ADMIN_EMAIL_HERE'
UNION ALL
SELECT 'public.users' as table_name, id, email, NULL 
FROM public.users 
WHERE email = 'ADMIN_EMAIL_HERE';

-- 2. Verify user metadata has role
SELECT id, email, 
       user_metadata->>'role' as user_role,
       app_metadata->>'role' as app_role
FROM auth.users 
WHERE email = 'ADMIN_EMAIL_HERE';

-- 3. Check public.users record
SELECT id, email, role, is_active 
FROM public.users 
WHERE email = 'ADMIN_EMAIL_HERE';

-- Common Issues:
-- ❌ UUID mismatch between auth.users and public.users
-- ❌ is_active = false in public.users
-- ❌ role not set in metadata or public.users
-- ❌ email not confirmed in auth.users
