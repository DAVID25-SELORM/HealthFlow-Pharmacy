-- Run after all tariff batches.
SELECT component, version, build, client_version, updated_at
FROM public.nhia_claimit_base_data_versions
ORDER BY component;

SELECT COUNT(*) AS feb_2023_tariff_rows
FROM public.nhia_tariff_items
WHERE tariff_version = 'FEB 2023';

SELECT source_file, COUNT(*) AS rows_seeded
FROM public.nhia_tariff_items
WHERE tariff_version = 'FEB 2023'
GROUP BY source_file
ORDER BY source_file;
