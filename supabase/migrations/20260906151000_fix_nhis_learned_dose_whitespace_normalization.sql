-- Correct the regex escape in the initial learned-dose migration without
-- rewriting existing observations or historical claims.

create or replace function public.nhis_normalize_dose_suggestion_text(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select nullif(
    regexp_replace(lower(btrim(coalesce(p_value, ''))), '\s+', ' ', 'g'),
    ''
  );
$$;

comment on function public.nhis_normalize_dose_suggestion_text(text) is
  'Canonicalizes learned-dose identity whitespace and case; it does not convert clinical units.';

notify pgrst, 'reload schema';
