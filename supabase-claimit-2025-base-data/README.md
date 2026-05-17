# NHIA / CLAIM-it 2025 Base Data Split Runner

Supabase Dashboard may truncate one very large SQL paste. Run these files one at a time in order:

1. `00-setup-reset-and-versions.sql`
2. `01-tariff-batch.sql` through `14-tariff-batch.sql`
3. `15-verify.sql`

Expected verification:

- `feb_2023_tariff_rows` = `2748`
- CLAIM-it versions show Service Tariff `FEB 2023`, Medicine Prices `MAY 2025`, Application build `2025053123`, Base Data `FEB 2023`

If any tariff batch fails or you lose track, rerun `00-setup-reset-and-versions.sql` first, then run all tariff batches again from `01`.
