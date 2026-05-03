-- Add pharmacy-level default markup used to auto-calculate selling prices from cost prices.
ALTER TABLE public.pharmacy_settings
ADD COLUMN IF NOT EXISTS default_markup_percent NUMERIC(7, 2) DEFAULT 0;

UPDATE public.pharmacy_settings
SET default_markup_percent = 0
WHERE default_markup_percent IS NULL;

ALTER TABLE public.pharmacy_settings
ALTER COLUMN default_markup_percent SET DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pharmacy_settings_default_markup_percent_nonnegative'
  ) THEN
    ALTER TABLE public.pharmacy_settings
    ADD CONSTRAINT pharmacy_settings_default_markup_percent_nonnegative
    CHECK (default_markup_percent >= 0);
  END IF;
END $$;
