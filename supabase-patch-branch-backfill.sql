-- ================================================
-- PATCH: Backfill main branches and user branch assignments
-- Date: 2026-04-27
-- ================================================

BEGIN;

INSERT INTO public.branches (organization_id, name, code, is_main, is_active)
SELECT o.id, COALESCE(NULLIF(o.name, ''), 'Main Branch'), 'MAIN', true, true
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1
  FROM public.branches b
  WHERE b.organization_id = o.id
);

UPDATE public.branches
SET is_main = true,
    is_active = true,
    updated_at = NOW()
WHERE id IN (
  SELECT DISTINCT ON (organization_id) id
  FROM public.branches
  WHERE organization_id IS NOT NULL
  ORDER BY organization_id, is_main DESC, created_at ASC
);

WITH main_branches AS (
  SELECT DISTINCT ON (organization_id)
    organization_id,
    id AS branch_id
  FROM public.branches
  WHERE is_active = true
  ORDER BY organization_id, is_main DESC, created_at ASC
)
UPDATE public.users u
SET branch_id = mb.branch_id,
    updated_at = NOW()
FROM main_branches mb
WHERE u.organization_id = mb.organization_id
  AND u.branch_id IS NULL
  AND u.organization_id IS NOT NULL;

COMMIT;
