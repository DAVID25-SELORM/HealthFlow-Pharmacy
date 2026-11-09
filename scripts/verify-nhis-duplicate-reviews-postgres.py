"""Disposable container only (--network none). Verifies the duplicate-review migration.

  docker run -d --rm --name hf-dup-review --network none -e POSTGRES_PASSWORD=x \
    public.ecr.aws/supabase/postgres:17.6.1.171
  python scripts/verify-nhis-duplicate-reviews-postgres.py
  docker stop hf-dup-review
"""
import subprocess
from pathlib import Path

C = 'hf-dup-review'
D = 'dup_review_check'


def command(db=D, role=None):
    return ['docker', 'exec', '-i', C, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db]


def sql(q, ok=True, db=D):
    r = subprocess.run(command(db), input=q, text=True, capture_output=True, timeout=30)
    if ok and r.returncode:
        raise AssertionError(r.stderr)
    if not ok:
        assert r.returncode, 'Expected rejection for: ' + q[:80]
    return r.stdout.strip() if ok else r.stderr


sql('drop database if exists ' + D + ';', db='postgres')
sql('create database ' + D + ';', db='postgres')
sql("""
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
create table organizations(id uuid primary key);
create table users(id uuid primary key, organization_id uuid, role text, assigned_roles text[], is_active boolean);
create table nhis_claims(id uuid primary key, organization_id uuid, status text, service_date_from date, ccc_no text);
create function public.user_organization_id() returns uuid language sql stable security definer
  as $$ select organization_id from public.users where id = auth.uid() $$;
create table audit_calls(event text, entity uuid, action text, details jsonb, org uuid);
create function public.log_audit_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_action text,
  p_details jsonb default '{}', p_organization_id uuid default null) returns void language sql
  as $$ insert into audit_calls values (p_event_type, p_entity_id, p_action, p_details, p_organization_id) $$;
grant all on all tables in schema public to authenticated;
""")
sql(Path('supabase/migrations/20261026090000_nhis_duplicate_export_reviews.sql').read_text())
# Re-running must be harmless.
sql(Path('supabase/migrations/20261026090000_nhis_duplicate_export_reviews.sql').read_text())

O = '00000000-0000-0000-0000-000000000001'
OTHER = '00000000-0000-0000-0000-000000000002'
ADMIN = '00000000-0000-0000-0000-0000000000a1'
OFFICER = '00000000-0000-0000-0000-0000000000a2'
MULTI = '00000000-0000-0000-0000-0000000000a3'
ASSISTANT = '00000000-0000-0000-0000-0000000000a4'
INACTIVE = '00000000-0000-0000-0000-0000000000a5'
OTHER_ADMIN = '00000000-0000-0000-0000-0000000000b1'
C1, C2, C3, C4, C5, CX = ['00000000-0000-0000-0000-00000000c0%02d' % i for i in (1, 2, 3, 4, 5, 9)]
sql(f"""
insert into organizations values('{O}'),('{OTHER}');
insert into users values
 ('{ADMIN}','{O}','admin',null,true),
 ('{OFFICER}','{O}','claims_officer',null,true),
 ('{MULTI}','{O}','pharmacist','{{pharmacist,claims_officer}}',true),
 ('{ASSISTANT}','{O}','assistant',null,true),
 ('{INACTIVE}','{O}','admin',null,false),
 ('{OTHER_ADMIN}','{OTHER}','admin',null,true);
insert into nhis_claims values
 ('{C1}','{O}','served','2026-05-14','CC-12345'),
 ('{C2}','{O}','submitted','2026-05-14','12345'),
 ('{C3}','{O}','served','2026-05-14','12345'),
 ('{C4}','{O}','served','2026-05-15','12345'),
 ('{C5}','{O}','rejected','2026-05-14','12345'),
 ('{CX}','{OTHER}','served','2026-05-14','12345');
""")
KEY = f'{O}|member:12345678|2026-05-14|12345'
REASON = 'Two prescriptions at one visit'


def as_user(uid, q, role='authenticated'):
    return f"set role {role}; set request.jwt.claim.sub='{uid}'; {q}"


def review(uid, ids, key=KEY, reason=REASON, ok=True):
    arr = "array[" + ",".join(f"'{i}'::uuid" for i in ids) + "]::uuid[]"
    return sql(as_user(uid, f"select review_nhis_duplicate_group('{key}', {arr}, '{reason}');"), ok)


# Allowed roles, including a multi-role user.
rid = review(ADMIN, [C2, C1])
assert len(rid) == 36
assert sql("select count(*) from nhis_duplicate_reviews where revoked_at is null;") == '1'
stored = sql("select claim_ids::text||'|'||ccc_no||'|'||service_date||'|'||reviewed_by from nhis_duplicate_reviews;")
assert stored == f'{{{C1},{C2}}}|12345|2026-05-14|{ADMIN}', stored  # sorted, CCC normalized to digits
review(OFFICER, [C1, C3])
review(MULTI, [C2, C3])
# The same set again updates the one active row instead of adding another.
review(ADMIN, [C1, C2], reason='Reviewed again after a re-check')
assert sql(f"select count(*) from nhis_duplicate_reviews where claim_ids=array['{C1}','{C2}']::uuid[] and revoked_at is null;") == '1'
assert sql("select count(*) from audit_calls where action='reviewed_not_duplicate';") == '4'

# Refusals.
assert 'administrator or claims officer' in review(ASSISTANT, [C1, C2], ok=False)
assert 'administrator or claims officer' in review(INACTIVE, [C1, C2], ok=False)
assert 'administrator or claims officer' in sql(as_user('00000000-0000-0000-0000-0000000000ff', f"select review_nhis_duplicate_group('{KEY}', array['{C1}','{C2}']::uuid[], '{REASON}');"), False)
assert 'reason' in review(ADMIN, [C1, C2], reason='short', ok=False)
assert 'between 2 and 50' in review(ADMIN, [C1], ok=False)
assert 'between 2 and 50' in review(ADMIN, [C1, C1], ok=False)
assert 'active claim of your facility' in review(ADMIN, [C1, CX], ok=False)       # another facility
assert 'active claim of your facility' in review(ADMIN, [C1, C5], ok=False)       # rejected claim
assert 'active claim of your facility' in review(ADMIN, [C1, '00000000-0000-0000-0000-00000000dead'], ok=False)
assert 'one service date' in review(ADMIN, [C1, C4], ok=False)                    # different service date
assert 'does not belong to your facility' in review(ADMIN, [C1, C2], key=f'{OTHER}|member:1|2026-05-14|12345', ok=False)
assert 'does not belong to your facility' in review(OTHER_ADMIN, [C1, C2], ok=False)
# Roles without a grant cannot call the functions or write the table directly.
assert 'permission denied' in sql(as_user(ADMIN, f"select review_nhis_duplicate_group('{KEY}', array['{C1}','{C2}']::uuid[], '{REASON}');", 'anon'), False)
assert 'permission denied' in sql(as_user(ADMIN, f"insert into nhis_duplicate_reviews(organization_id,group_key,claim_ids,service_date,ccc_no,reason,reviewed_by) values('{O}','k',array['{C1}','{C2}']::uuid[],'2026-05-14','12345','{REASON}','{ADMIN}');"), False)
assert 'permission denied' in sql(as_user(ADMIN, "update nhis_duplicate_reviews set reason='tampered tampered';"), False)
assert 'permission denied' in sql(as_user(ADMIN, "delete from nhis_duplicate_reviews;"), False)

# Tenant isolation on reads: each facility sees only its own decisions.
assert sql(as_user(ADMIN, "select count(*) from nhis_duplicate_reviews;")) .endswith('3')
assert sql(as_user(OTHER_ADMIN, "select count(*) from nhis_duplicate_reviews;")).endswith('0')
assert sql(as_user(ASSISTANT, "select count(*) from nhis_duplicate_reviews;")).endswith('3')  # staff can read to know a group is cleared

# Withdrawal.
rid_row = sql(f"select id from nhis_duplicate_reviews where claim_ids=array['{C1}','{C3}']::uuid[];")
assert 'administrator or claims officer' in sql(as_user(ASSISTANT, f"select revoke_nhis_duplicate_review('{rid_row}','Entered in error');"), False)
assert 'No active duplicate review' in sql(as_user(OTHER_ADMIN, f"select revoke_nhis_duplicate_review('{rid_row}','Entered in error');"), False)
assert 'reason' in sql(as_user(ADMIN, f"select revoke_nhis_duplicate_review('{rid_row}','no');"), False)
sql(as_user(ADMIN, f"select revoke_nhis_duplicate_review('{rid_row}','Entered in error');"))
assert sql(f"select (revoked_at is not null)::text||'|'||revoked_by||'|'||revoke_reason from nhis_duplicate_reviews where id='{rid_row}';") == f'true|{ADMIN}|Entered in error'
assert 'No active duplicate review' in sql(as_user(ADMIN, f"select revoke_nhis_duplicate_review('{rid_row}','Entered in error');"), False)
assert sql("select count(*) from audit_calls where action='review_withdrawn';") == '1'
# After withdrawal the same set can be reviewed again as a new row.
review(OFFICER, [C1, C3])
assert sql(f"select count(*) from nhis_duplicate_reviews where claim_ids=array['{C1}','{C3}']::uuid[];") == '2'

# The migration changes no claim data.
assert sql("select string_agg(status,',' order by id) from nhis_claims;") == 'served,submitted,served,served,rejected,served'
# An audit-function failure must not block or lose the decision.
sql("drop function public.log_audit_event(text,text,uuid,text,jsonb,uuid); create function public.log_audit_event(text,text,uuid,text,jsonb,uuid) returns void language plpgsql as $$ begin raise exception 'audit down'; end $$;")
review(ADMIN, [C2, C3, C1], reason='Audit failure still records the decision')
assert sql(f"select count(*) from nhis_duplicate_reviews where claim_ids=array['{C1}','{C2}','{C3}']::uuid[];") == '1'
print('PASS roles, multi-role, facility isolation, claim-set validation, immutability, tenant reads, withdrawal, re-review, idempotent migration')
