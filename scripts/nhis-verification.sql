-- Verifies the NHIS catalog import and inventory mirror.
-- Run in Supabase SQL Editor after applying/importing NHIS medicines.

SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'drugs'
  AND column_name IN ('nhis_code', 'nhis_price', 'nhis_unit', 'is_nhis_listed')
ORDER BY column_name;

SELECT
  o.name,
  COUNT(nd.id) AS catalog_count,
  COUNT(DISTINCT nd.code) AS distinct_codes,
  COUNT(*) FILTER (WHERE nd.unit_price IS NULL OR nd.unit_price < 0) AS invalid_prices
FROM public.organizations o
LEFT JOIN public.nhis_drugs nd
  ON nd.organization_id = o.id
 AND nd.is_active = true
WHERE o.can_use_nhis = true
GROUP BY o.name
ORDER BY o.name;

SELECT
  o.name,
  b.name AS branch_name,
  COUNT(d.id) FILTER (
    WHERE d.is_nhis_listed = true
      AND d.status = 'active'
  ) AS inventory_count,
  COUNT(DISTINCT d.nhis_code) FILTER (
    WHERE d.is_nhis_listed = true
      AND d.status = 'active'
  ) AS distinct_nhis_codes,
  COUNT(*) FILTER (
    WHERE d.is_nhis_listed = true
      AND (d.nhis_price IS NULL OR d.nhis_price < 0)
  ) AS invalid_inventory_prices
FROM public.organizations o
JOIN public.branches b
  ON b.organization_id = o.id
LEFT JOIN public.drugs d
  ON d.organization_id = o.id
 AND d.branch_id = b.id
WHERE o.can_use_nhis = true
  AND b.is_active = true
GROUP BY o.name, b.name
ORDER BY o.name, b.name;

WITH mismatches AS (
  SELECT
    o.name AS organization_name,
    b.name AS branch_name,
    d.nhis_code,
    d.name AS inventory_name,
    d.nhis_price,
    nd.unit_price
  FROM public.organizations o
  JOIN public.branches b
    ON b.organization_id = o.id
  JOIN public.drugs d
    ON d.organization_id = o.id
   AND d.branch_id = b.id
  JOIN public.nhis_drugs nd
    ON nd.organization_id = o.id
   AND nd.code = d.nhis_code
  WHERE o.can_use_nhis = true
    AND b.is_active = true
    AND d.is_nhis_listed = true
    AND d.status = 'active'
    AND ABS(COALESCE(d.nhis_price, -1) - COALESCE(nd.unit_price, -2)) > 0.001
)
SELECT COUNT(*) AS mismatch_count
FROM mismatches;
