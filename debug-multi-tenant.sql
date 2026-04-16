-- ================================================
-- DEBUG: Multi-Tenant Setup
-- ================================================
-- Run these queries one by one to verify setup

-- 1. Check if you have an organization
SELECT * FROM organizations;

-- 2. Check your user account (replace with your email)
SELECT id, email, full_name, role, organization_id 
FROM users 
WHERE email = 'your-email@example.com';  -- REPLACE WITH YOUR EMAIL

-- 3. Test the helper function (run while logged in)
SELECT public.user_organization_id();

-- 4. Check if current auth user has organization
SELECT 
    auth.uid() as my_user_id,
    u.email,
    u.organization_id,
    o.name as org_name,
    o.subdomain
FROM users u
LEFT JOIN organizations o ON o.id = u.organization_id
WHERE u.id = auth.uid();

-- 5. If organization_id is NULL, fix it by running:
-- (Uncomment and replace the email after checking query 1 for the org ID)

/*
UPDATE users 
SET organization_id = (SELECT id FROM organizations WHERE subdomain = 'healthflow' LIMIT 1)
WHERE email = 'your-email@example.com';  -- REPLACE WITH YOUR EMAIL
*/

-- 6. Verify drugs table has organization_id
SELECT id, name, organization_id 
FROM drugs 
LIMIT 5;

-- 7. Check RLS policies are active
SELECT schemaname, tablename, policyname 
FROM pg_policies 
WHERE schemaname = 'public' AND tablename = 'drugs'
ORDER BY policyname;

-- 8. Temporarily check all users organization_id status
SELECT 
    email,
    organization_id,
    CASE 
        WHEN organization_id IS NULL THEN 'NEEDS FIX ❌'
        ELSE 'OK ✅'
    END as status
FROM users;
