alter table public.pharmacy_settings
  add column if not exists facility_type text,
  add column if not exists website text,
  add column if not exists report_footer text,
  add column if not exists theme_primary_color text,
  add column if not exists theme_secondary_color text,
  add column if not exists theme_accent_color text,
  add column if not exists custom_header text,
  add column if not exists report_template text;
