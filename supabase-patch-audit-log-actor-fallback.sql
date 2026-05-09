-- Fixes sign-in audit rows that showed "Unknown" even though details.email was present.
-- Run in Supabase SQL Editor to backfill existing rows and harden future audit inserts.

BEGIN;

UPDATE public.audit_logs
SET actor_email = NULLIF(details->>'email', '')
WHERE (actor_email IS NULL OR actor_email = '')
  AND details ? 'email'
  AND NULLIF(details->>'email', '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_event_type TEXT,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_action TEXT,
  p_details JSONB DEFAULT '{}'::JSONB
)
RETURNS VOID AS $$
DECLARE
  actor_id UUID;
  actor_mail TEXT;
  detail_actor_user_id TEXT;
BEGIN
  actor_id := auth.uid();
  detail_actor_user_id := NULLIF(p_details->>'actor_user_id', '');

  IF actor_id IS NULL
    AND detail_actor_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    actor_id := detail_actor_user_id::UUID;
  END IF;

  actor_mail := COALESCE(
    NULLIF(auth.email(), ''),
    NULLIF(p_details->>'actor_email', ''),
    NULLIF(p_details->>'email', '')
  );

  INSERT INTO public.audit_logs (
    actor_user_id,
    actor_email,
    event_type,
    entity_type,
    entity_id,
    action,
    details,
    created_at
  )
  VALUES (
    actor_id,
    actor_mail,
    p_event_type,
    p_entity_type,
    p_entity_id,
    p_action,
    COALESCE(p_details, '{}'::JSONB),
    NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.log_audit_event(TEXT, TEXT, UUID, TEXT, JSONB) TO authenticated;

COMMIT;
