"""Disposable container only. Synthetic data; no network endpoints or production credentials.

Complements verify-nehfams-postgres.py with environment, role and tenant isolation checks.
Requires the same dedicated container and a fresh database name; it fails rather than reuse one.
"""
import subprocess, json
from pathlib import Path
C = 'hf-nehfams-audit-20261020'
D = 'nehfams_isolation'


def command(db=D): return ['docker', 'exec', '-i', C, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db]


def sql(q, ok=True, db=D):
    r = subprocess.run(command(db), input=q, text=True, capture_output=True, timeout=20)
    if ok and r.returncode: raise AssertionError(r.stderr)
    if not ok: assert r.returncode, 'Expected rejection: ' + q[:120]
    return r.stdout.strip() if ok else r.stderr


sql('create database ' + D + ';', db='postgres')
sql("""create table organizations(id uuid primary key);
create table branches(id uuid primary key,organization_id uuid);
create table users(id uuid primary key,organization_id uuid,branch_id uuid,role text,is_active boolean);
create table nhis_claims(id uuid primary key,organization_id uuid,branch_id uuid,member_no text,service_date_from date,ccc_no text);
create type branch_client as (organization_id uuid,branch_id uuid);
create function get_branch_sync_client(text) returns branch_client language sql as 'select null::uuid,null::uuid';
""")
for name in ['20261010090000_organization_ccc_providers.sql', '20261020200000_prepare_nehfams_connection.sql', '20261021090000_nehfams_test_validation_and_linkage.sql']:
    sql(Path('supabase/migrations', name).read_text())
O = '00000000-0000-0000-0000-000000000001'; OTHER = '00000000-0000-0000-0000-000000000002'
U = '00000000-0000-0000-0000-000000000003'; UO = '00000000-0000-0000-0000-000000000006'
B = '00000000-0000-0000-0000-000000000004'
sql(f"insert into organizations values('{O}'),('{OTHER}'); insert into branches values('{B}','{O}');"
    f"insert into users values('{U}','{O}','{B}','super_admin',true),('{UO}','{OTHER}',null,'super_admin',true);")


def reserve(member, org=O, actor=U, branch=B):
    branch_sql = f"'{branch}'" if branch else 'null'
    return f"select reserve_ccc_attendance('{org}','{actor}',{branch_sql},'draft','{member}','NHISCARD',current_date);"


def configure(org=O, actor=U, env='test'): return f"select configure_nehfams_connection('{org}','{actor}','{env}','synthetic-key','synthetic-secret','123','Test Facility');"


def validate(org=O, actor=U):
    version = sql(f"select version from organization_nehfams_connection where organization_id='{org}' and environment='test';")
    return f"select validate_nehfams_connection('{org}','{actor}','test',{version},'1FA',false);"


# 1. Only the service role may reach credentials, the ledger, the policy or the entry points.
for role in ['authenticated', 'anon']:
    for query in ['select count(*) from organization_nehfams_connection', 'select count(*) from ccc_attendance_requests',
                  'select count(*) from organization_ccc_policy', 'select count(*) from ccc_policy_audit',
                  reserve('12345678'), configure(), f"select validate_nehfams_connection('{O}','{U}','test',1,'1FA',false);", f"select activate_nehfams_test('{O}','{U}');"]:
        assert 'permission denied' in sql(f'set role {role}; ' + query, False), (role, query)
print('PASS anon and authenticated roles cannot read credentials, the ledger or policy, or call reservation/configuration functions')

# 2. Production NeHFAMS can never be enabled, even by direct table writes or the legacy entry point.
sql(configure(env='production'))
assert sql(f"select enabled from organization_ccc_policy where organization_id='{O}';") == 'f'
assert 'nehfams_production_disabled' in sql(f"update organization_ccc_policy set environment='production',enabled=true where organization_id='{O}';", False)
assert 'disabled' in sql(reserve('12345601'), False)
assert 'expected facility identity' in sql(f"select save_nehfams_connection('{OTHER}','{UO}','k2','s2');", False)
sql(f"update organization_ccc_policy set expected_hpn='123',expected_facility_name='Test Facility' where organization_id='{O}';")
sql(f"select save_nehfams_connection('{O}','{U}','k2','s2');")
assert sql(f"select provider||'/'||environment||'/'||enabled from organization_ccc_policy where organization_id='{O}';") == 'nehfams/production/false'
assert 'disabled' in sql(reserve('12345602'), False)
print('PASS production NeHFAMS stays disabled (constraint and entry points); reservation refused')

# 3. A test connection must be validated for its current credential version before it can be activated or used.
sql(configure()); assert 'Validate the test connection' in sql(f"select activate_nehfams_test('{O}','{U}');", False)
sql(validate()); sql(f"select activate_nehfams_test('{O}','{U}');")
first = json.loads(sql(reserve('12345678')))
assert first['cached'] is False and first['policy']['environment'] == 'test' and first['connection']['environment'] == 'test'
sql(f"update ccc_attendance_requests set status='not_created' where id='{first['request_id']}';")
sql("update organization_nehfams_connection set validated_at=now()-interval '25 hours' where environment='test';")
assert 'Validate the NeHFAMS test connection' in sql(reserve('12345678'), False)
sql(configure()); assert 'disabled' in sql(reserve('12345678'), False)
assert 'Validate the test connection' in sql(f"select activate_nehfams_test('{O}','{U}');", False)
print('PASS stale validation and rotated credentials block generation; rotation disables the policy')

# 4. Test attendance cannot be linked to a production claim.
sql(validate()); sql(f"select activate_nehfams_test('{O}','{U}');")
test_id = json.loads(sql(reserve('12345679')))['request_id']
sql(f"update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','01234') where id='{test_id}';")
claim = f"insert into nhis_claims values(gen_random_uuid(),'{O}','{B}','12345679',current_date,'01234','{test_id}');"
assert 'confirmed production attendance' in sql(claim, False)
assert sql('select count(*) from nhis_claims;') == '0'
print('PASS test-environment attendance cannot be linked to a claim')

# 5. A succeeded test record is never returned as a production attendance for the same member and day.
sql(f"select save_ccc_policy('{O}','{U}','existing',true,null,null,null,null);")
assert sql(f"select provider||'/'||environment from organization_ccc_policy where organization_id='{O}';") == 'existing/production'
production = json.loads(sql(reserve('12345679')))
assert production['cached'] is False and production['request_id'] != test_id and production['policy']['environment'] == 'production'
assert sql(f"select count(*) from ccc_attendance_requests where member_number='12345679' and status<>'not_created';") == '2'
print('PASS a test record is not reused as a production attendance; the two environments stay separate')

# 6. Another tenant neither inherits this facility's validation nor can be reserved for by its users.
sql(configure(OTHER, UO))
assert 'disabled' in sql(reserve('12345680', OTHER, UO, None), False)
assert 'membership' in sql(reserve('12345680', OTHER, U, B), False)
assert 'membership' in sql(reserve('12345680', O, UO, B), False)
assert sql(f"select count(*) from organization_nehfams_connection where organization_id='{OTHER}' and validated_at is not null;") == '0'
sql(validate(OTHER, UO)); sql(f"select activate_nehfams_test('{OTHER}','{UO}');")
other = json.loads(sql(reserve('12345680', OTHER, UO, None)))
assert other['policy']['organization_id'] == OTHER and other['connection']['organization_id'] == OTHER
assert sql(f"select count(*) from ccc_attendance_requests where organization_id='{O}' and member_number='12345680';") == '0'
print('PASS tenant separation: no inherited validation, cross-tenant reservation refused, connections stay per organization')
print('PASS PostgreSQL ' + sql('show server_version;'))
