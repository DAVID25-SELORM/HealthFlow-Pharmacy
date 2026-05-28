BEGIN;

ALTER FUNCTION public.branch_sync_token_hash(text) STABLE;

ALTER FUNCTION public.branch_sync_upsert_offline_record(text, text, uuid, jsonb)
  SET search_path = public, extensions;

COMMIT;
