-- User confirmed ABC PHARMACY and WESTPOINT CHEMIST operate entirely online.
-- Disable only the ten registrations in the supplied production export.
-- This revokes their future branch synchronization access; clinical data is retained.
begin;
create temporary table nhis_retired_branch_targets (
  id uuid primary key, facility_name text not null
) on commit drop;
insert into nhis_retired_branch_targets values
  ('ef21f77e-1246-4bad-9977-2fce6227c97d'::uuid, 'ABC PHARMACY'),
  ('f74e7d76-54c4-4242-a44d-41825f605cf6'::uuid, 'ABC PHARMACY'),
  ('93f0daef-b3a3-452b-b0ff-a99b9e7df51d'::uuid, 'ABC PHARMACY'),
  ('8a1b9115-e516-4d07-b7c1-dba9511a0360'::uuid, 'WESTPOINT CHEMIST'),
  ('23017986-695b-487a-8b71-e5212896dff8'::uuid, 'WESTPOINT CHEMIST'),
  ('5c33039b-b07a-4373-ac3e-aef26cc51eb4'::uuid, 'WESTPOINT CHEMIST'),
  ('824442a9-9523-45f5-add4-fffa18fcefcd'::uuid, 'WESTPOINT CHEMIST'),
  ('37760320-4ef7-4563-b547-2de54da94069'::uuid, 'WESTPOINT CHEMIST'),
  ('1b2e41ca-ab7b-49ac-b81b-98da67eea382'::uuid, 'WESTPOINT CHEMIST'),
  ('50235c9f-33e4-47d5-965c-f94fcfd03112'::uuid, 'WESTPOINT CHEMIST');
do $$
begin
  perform 1 from public.branch_sync_clients c
  join nhis_retired_branch_targets t on t.id=c.id for update of c;
  if (select count(*) from public.branch_sync_clients c
      join nhis_retired_branch_targets t on t.id=c.id
      join public.organizations o on o.id=c.organization_id
      where o.name=t.facility_name) <> 10 then
    raise exception 'Branch registration scope changed. Re-export the rollout audit before proceeding.';
  end if;
end;
$$;
update public.branch_sync_clients c
set is_active=false
from nhis_retired_branch_targets t
where c.id=t.id and c.is_active=true;
select o.name as facility,c.name as registration,c.id,c.is_active,c.last_seen_at
from public.branch_sync_clients c
join nhis_retired_branch_targets t on t.id=c.id
join public.organizations o on o.id=c.organization_id
order by o.name,c.name,c.id;
commit;
