alter table public.pharmacy_settings
  add column if not exists nhis_return_alert_enabled boolean not null default true,
  add column if not exists nhis_return_alert_window_hours integer not null default 24,
  add column if not exists nhis_return_alert_require_reason boolean not null default true,
  add column if not exists nhis_return_alert_allowed_roles text[] not null default array['admin', 'claims_officer', 'assistant']::text[];

alter table public.pharmacy_settings
  drop constraint if exists pharmacy_settings_nhis_return_alert_window_hours_check;

alter table public.pharmacy_settings
  add constraint pharmacy_settings_nhis_return_alert_window_hours_check
  check (nhis_return_alert_window_hours in (6, 12, 24, 48));

alter table public.nhis_claims
  add column if not exists nhis_return_override_reason text,
  add column if not exists nhis_return_previous_claim_id text;
