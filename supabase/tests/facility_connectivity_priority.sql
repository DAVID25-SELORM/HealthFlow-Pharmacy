-- Run only in an empty disposable PostgreSQL database with psql.
\set ON_ERROR_STOP on
create schema if not exists auth;
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql as $$ select '{}'::jsonb $$;
create table public.organizations(id uuid primary key, name text, status text);
create table public.users(id uuid primary key, organization_id uuid, is_active boolean, role text);
create table public.branches(id uuid primary key, organization_id uuid, is_active boolean);
create table public.branch_sync_clients(id uuid primary key, organization_id uuid, branch_id uuid, is_active boolean, last_seen_at timestamptz);
\ir ../migrations/20260911010000_add_facility_connectivity.sql
\ir ../migrations/20260911020000_prioritize_facility_connectivity.sql
insert into organizations select md5(n::text)::uuid, 'Facility ' || lpad(n::text, 3, '0'), 'active' from generate_series(1, 160) n;
insert into users select id, id, true, 'admin' from organizations;
insert into users values ('00000000-0000-0000-0000-000000000001', null, true, 'super_admin');
select set_config('test.uid', '00000000-0000-0000-0000-000000000001', false);
-- Online 1-40; recently active 41-80; offline 81-120; never 121-160.
insert into facility_browser_contacts
select md5(n::text)::uuid, md5(n::text)::uuid, md5(n::text)::uuid,
  now() - case when n <= 40 then n * interval '1 second'
    when n <= 80 then interval '20 minutes' + n * interval '1 second'
    else interval '1 hour' + n * interval '1 second' end
from generate_series(1, 120) n;
do $$ declare result jsonb; again jsonb; begin
 result := get_facility_connectivity(); again := get_facility_connectivity();
 if result <> again then raise exception 'Non-deterministic result'; end if;
 if jsonb_array_length(result->'facilities') <> 160 then raise exception 'List truncated before sorting'; end if;
 if result#>>'{facilities,0,name}' <> 'Facility 001' or result#>>'{facilities,39,name}' <> 'Facility 040' then raise exception 'Newest Online order failed'; end if;
 if result#>>'{facilities,40,connectivityStatus}' <> 'RECENTLY_ACTIVE' or result#>>'{facilities,80,connectivityStatus}' <> 'OFFLINE' then raise exception 'Priority failed'; end if;
 if result#>>'{facilities,120,name}' <> 'Facility 121' or result#>>'{facilities,159,name}' <> 'Facility 160' then raise exception 'Never ordering failed'; end if;
 -- Pagination consumers slice only after global ordering; Online is not stranded on another page.
 if (select count(*) from jsonb_array_elements(result->'facilities') with ordinality r(v,n) where n <= 40 and v->>'connectivityStatus' = 'ONLINE') <> 40 then raise exception 'Page boundary priority failed'; end if;
 update facility_browser_contacts set last_seen_at = now() where user_id = md5('100')::uuid;
 result := get_facility_connectivity();
 if result#>>'{facilities,0,name}' <> 'Facility 100' then raise exception 'Offline to Online transition failed'; end if;
 update facility_browser_contacts set last_seen_at = now() - interval '25 minutes' where user_id = md5('100')::uuid;
 result := get_facility_connectivity();
 if result#>>'{facilities,80,name}' <> 'Facility 100' then raise exception 'Online to Recently Active transition failed'; end if;
 -- Same timestamp and name must still tie-break by immutable UUID.
 update organizations set name = 'Identical' where id in (md5('1')::uuid, md5('2')::uuid);
 update facility_browser_contacts set last_seen_at = now() where user_id in (md5('1')::uuid, md5('2')::uuid);
 result := get_facility_connectivity();
 if (result#>>'{facilities,0,id}')::uuid > (result#>>'{facilities,1,id}')::uuid then raise exception 'UUID tie-break failed'; end if;
end $$;
-- Server evidence alone is sufficient for Online; stale registered server requires attention.
insert into branches values (md5('branch')::uuid, md5('150')::uuid, true);
insert into branch_sync_clients values (md5('client')::uuid, md5('150')::uuid, md5('branch')::uuid, true, now());
do $$ declare result jsonb; begin
 result := get_facility_connectivity();
 if result#>>'{facilities,0,name}' <> 'Facility 150' then raise exception 'Server-only Online failed'; end if;
 update branch_sync_clients set last_seen_at = now() - interval '1 hour';
 result := get_facility_connectivity();
 if not exists(select from jsonb_array_elements(result->'facilities') f where f->>'name' = 'Facility 150' and f->>'connectivityStatus' = 'ATTENTION_REQUIRED') then raise exception 'Attention failed'; end if;
 perform set_config('test.uid', md5('1')::uuid::text, false);
 begin perform get_facility_connectivity(); raise exception 'Staff summary access allowed'; exception when insufficient_privilege then null; end;
end $$;
select 'PASS: priority, recency, transitions, full list/page boundaries, deterministic ties, server evidence and permissions';
