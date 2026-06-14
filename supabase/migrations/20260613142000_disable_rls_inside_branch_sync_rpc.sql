BEGIN;

ALTER FUNCTION public.branch_sync_upsert_offline_record(TEXT, TEXT, UUID, JSONB)
  SET row_security = off;

COMMIT;
