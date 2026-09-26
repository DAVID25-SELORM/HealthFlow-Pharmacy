-- Captured from production (2026-09-26): claimit_artifact_actor() exists in the live database but no migration in
-- this repository created it (found while reconciling migration drift). It is reproduced here exactly, so a database
-- rebuilt from migrations matches production. Idempotent: create or replace with the same body and the same grants
-- (service role only; it verifies a JWT-verified actor on behalf of service-role RPCs).
begin;

create or replace function public.claimit_artifact_actor(p_actor uuid, p_org uuid, p_branch uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare actor public.users%rowtype;
begin
  -- Only service-role RPCs call this after the gateway verifies the human JWT.
  perform set_config('request.jwt.claim.sub',p_actor::text,true);
  actor:=public.claimit_actor(p_org);
  if p_actor is null or actor.id is distinct from p_actor then raise exception 'Access denied.' using errcode='42501'; end if;
  if p_branch is not null and actor.branch_id is distinct from p_branch
    and not coalesce(actor.role='admin' or 'admin'=any(actor.assigned_roles),false) then
    raise exception 'Facility access denied.' using errcode='42501';
  end if;
end $$;

revoke all on function public.claimit_artifact_actor(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claimit_artifact_actor(uuid, uuid, uuid) to service_role;

commit;
