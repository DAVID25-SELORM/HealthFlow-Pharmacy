"""Disposable container only. Synthetic data; no network endpoints or production credentials.

Verifies 20261022090000_nehfams_production_single_facility.sql in an isolated PostgreSQL: production NeHFAMS needs a
per-facility approval, validation and activation; the approved attendance limit is consumed atomically with each new
reservation (rollback-safe and concurrency-safe); revocation stops it; other facilities are unaffected; and only the
service role can approve, activate, revoke or read approvals. Requires a fresh database name; fails rather than reuse one.
"""
import subprocess, json, time, concurrent.futures
from pathlib import Path
C = 'hf-nehfams-audit-20261020'
D = 'nehfams_production'


def command(db=D): return ['docker', 'exec', '-i', C, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db]


def sql(q, ok=True, db=D):
    r = subprocess.run(command(db), input=q, text=True, capture_output=True, timeout=30)
    if ok and r.returncode: raise AssertionError(r.stderr)
    if not ok: assert r.returncode, 'Expected rejection: ' + q[:140]
    return r.stdout.strip() if ok else r.stderr


sql('create database ' + D + ';', db='postgres')
sql("""create table organizations(id uuid primary key);
create table branches(id uuid primary key,organization_id uuid);
create table users(id uuid primary key,organization_id uuid,branch_id uuid,role text,is_active boolean);
create table nhis_claims(id uuid primary key,organization_id uuid,branch_id uuid,member_no text,service_date_from date,ccc_no text);
create type branch_client as (organization_id uuid,branch_id uuid);
create function get_branch_sync_client(text) returns branch_client language sql as 'select null::uuid,null::uuid';
""")
for name in ['20261010090000_organization_ccc_providers.sql', '20261020200000_prepare_nehfams_connection.sql',
             '20261021090000_nehfams_test_validation_and_linkage.sql', '20261022090000_nehfams_production_single_facility.sql']:
    sql(Path('supabase/migrations', name).read_text())
O = '00000000-0000-0000-0000-000000000001'; OTHER = '00000000-0000-0000-0000-000000000002'
ADMIN = '00000000-0000-0000-0000-000000000003'; STAFF = '00000000-0000-0000-0000-000000000006'; OTHER_ADMIN = '00000000-0000-0000-0000-000000000007'
B = '00000000-0000-0000-0000-000000000004'
sql(f"insert into organizations values('{O}'),('{OTHER}'); insert into branches values('{B}','{O}');"
    f"insert into users values('{ADMIN}','{O}','{B}','super_admin',true),('{STAFF}','{O}','{B}','pharmacist',true),('{OTHER_ADMIN}','{OTHER}',null,'super_admin',true);")

REF = 'NHIA-AUTH-2026-0001'


def reserve(member, org=O, actor=ADMIN, branch=B):
    return f"select reserve_ccc_attendance('{org}','{actor}','{branch}','draft','{member}','NHISCARD',current_date);"


def used(org=O): return int(sql(f"select attendances_used from nehfams_production_approval where organization_id='{org}';"))


def configure(org=O, actor=ADMIN): return f"select configure_nehfams_connection('{org}','{actor}','production','synthetic-key','synthetic-secret','123','Test Facility');"


def validate(org=O, actor=ADMIN):
    version = sql(f"select version from organization_nehfams_connection where organization_id='{org}' and environment='production';")
    return f"select validate_nehfams_connection('{org}','{actor}','production',{version},'1FA',false);"


def activate(org=O, actor=ADMIN): return f"select activate_nehfams_production('{org}','{actor}');"


def approve(limit=1, org=O, actor=ADMIN, ref=REF): return f"select approve_nehfams_production('{org}','{actor}','{ref}',{limit});"


# 1. Nothing can switch production on without an approval, by any route.
sql(configure()); sql(validate())
assert 'not approved' in sql(activate(), False)
assert 'not approved' in sql(f"update organization_ccc_policy set enabled=true where organization_id='{O}';", False)
assert 'disabled' in sql(reserve('12345601'), False)
print('PASS production cannot be enabled, by the function or by a direct write, without an approval')

# 2. Approval needs a platform administrator, a real reference and a sane limit.
assert 'Platform administrator' in sql(approve(actor=STAFF), False)
assert 'authorization reference' in sql(approve(ref='short'), False)
for bad in ('0', '101', 'null'): assert 'limit' in sql(approve(limit=bad), False)
assert 'Unknown facility' in sql(approve(org='00000000-0000-0000-0000-0000000000ff'), False)
sql(approve(limit=1))
assert used() == 0
assert json.loads(sql(f"select details from ccc_policy_audit where action='approve_nehfams_production' and organization_id='{O}';"))['reference'] == REF
print('PASS approval requires an administrator, an NHIA reference and a limit of 1-100, and is audited')

# 3. Activation also needs a currently validated production connection and no unresolved attendance.
sql(configure())  # credential change invalidates the earlier validation
assert 'Validate the production connection first' in sql(activate(), False)
sql(validate()); sql(activate())
assert sql(f"select provider||'/'||environment||'/'||enabled from organization_ccc_policy where organization_id='{O}';") == 'nehfams/production/true'
print('PASS activation requires a validated production connection and then enables only this facility')

# 4. The approved limit is consumed by new reservations only, never by cached repeats.
first = json.loads(sql(reserve('12345678')))
assert first['cached'] is False and first['policy']['environment'] == 'production' and used() == 1
sql(f"update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','01234') where id='{first['request_id']}';")
assert json.loads(sql(reserve('12345678')))['cached'] is True and used() == 1
assert 'attendance limit is used up' in sql(reserve('12345679'), False)
assert used() == 1
print('PASS limit of 1: first reservation allowed, repeat served from cache without using it, second member refused')

# 5. Re-approval resets the allowance; a rolled-back reservation does not consume it.
sql(approve(limit=2)); assert used() == 0
sql('begin;' + reserve('12345680') + 'rollback;'); assert used() == 0
second = json.loads(sql(reserve('12345680')))
assert used() == 1
sql(f"update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','02345') where id='{second['request_id']}';")
sql(reserve('12345681')); assert used() == 2
assert 'attendance limit is used up' in sql(reserve('12345682'), False) and used() == 2
print('PASS re-approval resets the allowance; a rolled-back reservation does not use it; the new limit of 2 is enforced')

# 6. Concurrent reservations cannot exceed the limit: the second session waits for the lock, then is refused.
sql("update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','03456') where status='pending';")
sql(approve(limit=1)); assert used() == 0
a = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
a.stdin.write('begin;' + reserve('12345690') + '\n'); a.stdin.flush()
winner = json.loads(a.stdout.readline())
with concurrent.futures.ThreadPoolExecutor() as pool:
    waiter = pool.submit(sql, "set application_name='nehfams_prod_waiter';" + reserve('12345691'), False)
    waiting = False
    for _ in range(60):
        if sql("select count(*) from pg_stat_activity where application_name='nehfams_prod_waiter' and wait_event_type='Lock';") != '0': waiting = True; break
        time.sleep(.05)
    assert waiting, 'Independent connection did not wait for the lock'
    a.stdin.write('commit;\n' + chr(92) + 'q\n'); a.stdin.flush(); a.wait(timeout=10)
    assert 'attendance limit is used up' in waiter.result(timeout=20)
assert used() == 1 and winner['request_id']
print('PASS two independent sessions cannot exceed the limit; the second waited for the lock and was refused')

# 7. Revocation disables the facility immediately and activation then needs a fresh approval.
sql(f"select revoke_nehfams_production('{O}','{ADMIN}');")
assert sql(f"select enabled from organization_ccc_policy where organization_id='{O}';") == 'f'
assert 'disabled' in sql(reserve('12345692'), False)
assert 'Reconcile unresolved attendance' in sql(activate(), False)  # the concurrency winner is still pending
sql("update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','05678') where status='pending';")
assert 'not approved' in sql(activate(), False)
assert 'Platform administrator' in sql(f"select revoke_nehfams_production('{O}','{STAFF}');", False)
print('PASS revocation disables generation at once and blocks reactivation until re-approved')

# 8. Another facility is unaffected by this facility's approval.
sql(configure(OTHER, OTHER_ADMIN)); sql(validate(OTHER, OTHER_ADMIN))
assert 'not approved' in sql(activate(OTHER, OTHER_ADMIN), False)
assert 'not approved' in sql(f"update organization_ccc_policy set provider='nehfams',environment='production',enabled=true where organization_id='{OTHER}';", False)
print('PASS an unapproved facility cannot enable production')

# 9. Rollback to the existing provider stays possible once nothing is unresolved.
sql(approve(limit=3)); sql(configure()); sql(validate()); sql(activate())
sql("update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','04567') where status='pending';")
sql(f"select save_ccc_policy('{O}','{ADMIN}','existing',true,null,null,null,null);")
assert sql(f"select provider||'/'||environment from organization_ccc_policy where organization_id='{O}';") == 'existing/production'
print('PASS switching back to the existing provider works after an approved production run')

# 10. Only the service role can approve, activate, revoke or read approvals.
for role in ['authenticated', 'anon']:
    for query in ['select count(*) from nehfams_production_approval', approve(), activate(), f"select revoke_nehfams_production('{O}','{ADMIN}');"]:
        assert 'permission denied' in sql(f'set role {role}; ' + query, False), (role, query)
print('PASS anon and authenticated roles cannot approve, activate, revoke or read approvals')
print('PASS PostgreSQL ' + sql('show server_version;'))
