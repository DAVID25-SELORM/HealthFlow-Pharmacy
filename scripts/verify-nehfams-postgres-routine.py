"""Run baseline and routine-production checks in a fresh disposable PostgreSQL database."""
from pathlib import Path
import uuid
baseline=Path('scripts/verify-nehfams-postgres-production.py').read_text()
exec(baseline.replace("D = 'nehfams_production'", "D = 'nehfams_routine_"+uuid.uuid4().hex[:10]+"'"))
sql(Path('supabase/migrations/20261023090000_nehfams_routine_production.sql').read_text())
def routine(org=O,actor=ADMIN): return f"select activate_nehfams_routine_production('{org}','{actor}');"
assert 'Platform administrator' in sql(routine(actor=STAFF),False)
for role in ['anon','authenticated']:
 assert 'permission denied' in sql('set role '+role+';'+routine(),False)
sql(configure());sql(validate());sql(routine())
start=used()
for m in ['23456780','23456781','23456782','23456783']:
 r=json.loads(sql(reserve(m)))
 sql(f"update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','01234') where id='{r['request_id']}';")
assert used()==start+4
assert json.loads(sql(reserve('23456780')))['cached'] is True
assert used()==start+4
assert sql(f"select count(*) from nehfams_production_approval where organization_id='{OTHER}' and routine_enabled;")=='0'
sql(reserve('23456784'))
assert 'Reconcile unresolved' in sql(routine(),False)
assert 'unresolved' in sql(reserve('23456784'),False)
sql(f"select revoke_nehfams_production('{O}','{ADMIN}');")
assert 'disabled' in sql(reserve('23456785'),False)
sql(f"update organization_nehfams_connection set validated_at=null where organization_id='{OTHER}';")
assert 'Validate' in sql(routine(OTHER,OTHER_ADMIN),False)
assert sql(f"select count(*) from nehfams_production_approval where organization_id='{OTHER}' and routine_enabled;")=='0'
print('PASS routine activation permissions, no cap, usage preservation, cached reuse, unresolved guard, tenant isolation, revocation and failed-activation rollback')
