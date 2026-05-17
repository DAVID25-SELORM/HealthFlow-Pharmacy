from pathlib import Path
import re


SOURCE = Path("supabase-patch-nhia-claimit-2025-base-data.sql")
OUT_DIR = Path("supabase-claimit-2025-base-data")


def main() -> None:
    sql = SOURCE.read_text(encoding="utf-8")
    first_batch = sql.index("-- Tariff seed batch 1")
    final_commit = sql.rindex("\nCOMMIT;")

    setup_sql = sql[:first_batch].rstrip() + "\n\nCOMMIT;\n"
    batches_sql = sql[first_batch:final_commit].strip()
    batches = re.split(r"\n(?=-- Tariff seed batch \d+ of \d+)", batches_sql)

    OUT_DIR.mkdir(exist_ok=True)
    (OUT_DIR / "00-setup-reset-and-versions.sql").write_text(setup_sql, encoding="utf-8")

    for index, batch in enumerate(batches, start=1):
        batch_sql = (
            "-- Run after 00-setup-reset-and-versions.sql.\n"
            "-- If this batch was already run and you need to restart, rerun 00 first.\n\n"
            "BEGIN;\n\n"
            f"{batch.strip()}\n\n"
            "COMMIT;\n"
        )
        (OUT_DIR / f"{index:02d}-tariff-batch.sql").write_text(batch_sql, encoding="utf-8")

    verify_sql = """-- Run after all tariff batches.
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
"""
    (OUT_DIR / "15-verify.sql").write_text(verify_sql, encoding="utf-8")

    index_text = """# NHIA / CLAIM-it 2025 Base Data Split Runner

Supabase Dashboard may truncate one very large SQL paste. Run these files one at a time in order:

1. `00-setup-reset-and-versions.sql`
2. `01-tariff-batch.sql` through `14-tariff-batch.sql`
3. `15-verify.sql`

Expected verification:

- `feb_2023_tariff_rows` = `2748`
- CLAIM-it versions show Service Tariff `FEB 2023`, Medicine Prices `MAY 2025`, Application build `2025053123`, Base Data `FEB 2023`

If any tariff batch fails or you lose track, rerun `00-setup-reset-and-versions.sql` first, then run all tariff batches again from `01`.
"""
    (OUT_DIR / "README.md").write_text(index_text, encoding="utf-8")

    print(f"Wrote setup, {len(batches)} tariff batches, verify SQL, and README to {OUT_DIR}.")


if __name__ == "__main__":
    main()
