from __future__ import annotations

import pathlib
import re
import sys

import pdfplumber


PDF_PATH = pathlib.Path(
    r"C:\Users\RealTimeIT\Downloads\Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf"
)
OUTPUT_PATH = pathlib.Path(
    "supabase-patch-private-primary-care-hospital-exclusive-tariff-feb-2023.sql"
)
SOURCE_FILE = "Private Primary Care Hospital (Catering Exclusive) Tariff JAN 2023 (1).pdf"
EXPECTED_ROW_COUNT = 617


def sql_quote(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def age_band_from_description(description: str) -> str | None:
    if "<12 Yrs" in description or "< 12 Yrs" in description:
        return "<12 Yrs"
    if ">= 12 Yrs" in description:
        return ">= 12 Yrs"
    if ">=12 Yrs" in description:
        return ">=12 Yrs"
    return None


def extract_rows() -> list[tuple[int, str, str, str, str | None, str]]:
    rows: list[tuple[int, str, str, str, str | None, str]] = []

    with pdfplumber.open(PDF_PATH) as pdf:
        for page_number, page in enumerate(pdf.pages, start=1):
            for table in page.extract_tables():
                mdc = None
                for raw_row in table:
                    if not raw_row or len(raw_row) < 3:
                        continue

                    code = " ".join((raw_row[0] or "").split())
                    description = " ".join((raw_row[1] or "").split())
                    amount = " ".join((raw_row[2] or "").split()).replace(",", "")

                    if code == "G-DRG":
                        mdc = description.title()
                        continue

                    if not re.match(r"^[A-Z]{3,5}\d{2,3}[A-Z]?$", code):
                        continue

                    if not re.match(r"^[0-9]+\.\d{2}$", amount):
                        continue

                    rows.append(
                        (
                            page_number,
                            mdc or "Unclassified",
                            code,
                            description,
                            age_band_from_description(description),
                            amount,
                        )
                    )

    return rows


def write_patch(rows: list[tuple[int, str, str, str, str | None, str]]) -> None:
    with OUTPUT_PATH.open("w", encoding="utf-8", newline="\n") as file:
        file.write("-- ================================================================\n")
        file.write("-- PATCH: Private Primary Care Hospital catering-exclusive G-DRG tariffs\n")
        file.write("-- ================================================================\n")
        file.write(f"-- Source PDF: {SOURCE_FILE}\n")
        file.write(
            "-- PDF title/effective date: G-DRG Revised Tariffs 2023 Version 1.0, "
            "effective 1 February 2023.\n"
        )
        file.write(
            "-- Scope: Upserts only Private Primary Care Hospital / catering exclusive tariff rows.\n"
        )
        file.write(f"-- Extracted rows: {EXPECTED_ROW_COUNT} unique G-DRG codes.\n")
        file.write("-- ================================================================\n\n")
        file.write("BEGIN;\n\n")
        file.write("WITH seed_rows (\n")
        file.write(
            "  tariff_version, facility_group, catering_option, mdc, gdrg_code, description,\n"
        )
        file.write(
            "  age_band, tariff_amount, currency, source_file, source_page, is_active\n"
        )
        file.write(") AS (\n")
        file.write("  VALUES\n")

        values = []
        for page_number, mdc, code, description, age_band, amount in rows:
            values.append(
                "  ("
                "'FEB 2023', "
                "'Private Primary Care Hospital', "
                "'exclusive', "
                f"{sql_quote(mdc)}, "
                f"{sql_quote(code)}, "
                f"{sql_quote(description)}, "
                f"{sql_quote(age_band)}, "
                f"{amount}, "
                "'GHS', "
                f"{sql_quote(SOURCE_FILE)}, "
                f"{page_number}, "
                "true)"
            )

        file.write(",\n".join(values))
        file.write("\n)\n")
        file.write("INSERT INTO public.nhia_tariff_items (\n")
        file.write(
            "  tariff_version, facility_group, catering_option, mdc, gdrg_code, description,\n"
        )
        file.write(
            "  age_band, tariff_amount, currency, source_file, source_page, is_active, updated_at\n"
        )
        file.write(")\n")
        file.write("SELECT\n")
        file.write(
            "  tariff_version, facility_group, catering_option, mdc, gdrg_code, description,\n"
        )
        file.write(
            "  age_band, tariff_amount, currency, source_file, source_page, is_active, NOW()\n"
        )
        file.write("FROM seed_rows\n")
        file.write(
            "ON CONFLICT (tariff_version, facility_group, catering_option, gdrg_code) DO UPDATE SET\n"
        )
        file.write("  mdc = EXCLUDED.mdc,\n")
        file.write("  description = EXCLUDED.description,\n")
        file.write("  age_band = EXCLUDED.age_band,\n")
        file.write("  tariff_amount = EXCLUDED.tariff_amount,\n")
        file.write("  currency = EXCLUDED.currency,\n")
        file.write("  source_file = EXCLUDED.source_file,\n")
        file.write("  source_page = EXCLUDED.source_page,\n")
        file.write("  is_active = EXCLUDED.is_active,\n")
        file.write("  updated_at = NOW();\n\n")
        file.write("DO $$\n")
        file.write("DECLARE\n")
        file.write("  seeded_count INTEGER;\n")
        file.write("BEGIN\n")
        file.write("  SELECT COUNT(*) INTO seeded_count\n")
        file.write("  FROM public.nhia_tariff_items\n")
        file.write("  WHERE tariff_version = 'FEB 2023'\n")
        file.write("    AND facility_group = 'Private Primary Care Hospital'\n")
        file.write("    AND catering_option = 'exclusive';\n\n")
        file.write(f"  IF seeded_count <> {EXPECTED_ROW_COUNT} THEN\n")
        file.write(
            "    RAISE EXCEPTION 'Expected 617 Private Primary Care Hospital exclusive tariff rows, found %', seeded_count;\n"
        )
        file.write("  END IF;\n")
        file.write("END $$;\n\n")
        file.write("COMMIT;\n")


def main() -> int:
    if not PDF_PATH.exists():
        print(f"Missing PDF: {PDF_PATH}", file=sys.stderr)
        return 1

    rows = extract_rows()
    unique_codes = {row[2] for row in rows}
    if len(rows) != EXPECTED_ROW_COUNT or len(unique_codes) != EXPECTED_ROW_COUNT:
        print(
            f"Expected {EXPECTED_ROW_COUNT} unique rows, got {len(rows)} rows / {len(unique_codes)} codes",
            file=sys.stderr,
        )
        return 1

    write_patch(rows)
    print(f"Wrote {OUTPUT_PATH} with {len(rows)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
