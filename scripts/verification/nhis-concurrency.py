"""Run only against the disposable healthflow-nhis-concurrency-audit container.
No host port, credentials, production data, or external database connection.
Start a fresh PostgreSQL container before each run; this script creates its fixture.
"""
from pathlib import Path
import argparse
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--container', default='healthflow-nhis-concurrency-audit')
parser.add_argument('--alias', action='store_true')
parser.add_argument('--patched', action='store_true')
parser.add_argument('--final-batch', action='store_true')
args = parser.parse_args()
CONTAINER = args.container
if not CONTAINER.startswith('healthflow-nhis-concurrency-audit'):
    raise ValueError('Use a disposable NHIS audit container only')
ORG = '00000000-0000-0000-0000-000000000001'
PRIOR = '00000000-0000-0000-0000-000000000002'
CURRENT = '00000000-0000-0000-0000-000000000003'

def sql(query, check=True):
    result = subprocess.run(['docker','exec','-i',CONTAINER,'psql','-h','/tmp','-U','postgres','-d','postgres','-X','-A','-t','-v','ON_ERROR_STOP=1'],input=query,text=True,capture_output=True,timeout=45)
    if check and result.returncode:
        raise RuntimeError(result.stderr)
    return result

def read(name):
    return (ROOT / 'supabase/migrations' / name).read_text()

fixture = (ROOT / 'src/services/nhisServingCoverageMigration.test.js').read_text()
bootstrap = fixture.split('await db.exec(`',1)[1].split('`)',1)[0]
bootstrap = bootstrap.replace('${org}',ORG)
deadline = time.monotonic()+45
while sql('select 1',check=False).returncode:
    if time.monotonic()>deadline: raise RuntimeError('Disposable database did not become ready')
    time.sleep(0.5)
sql(bootstrap)
serving = read('20260912170000_enforce_nhis_ccc_transitions.sql')
sql(serving[serving.index('create or replace function public.serve_nhis_claim_medicines'):serving.index('notify pgrst')])
sql(read('20260801100000_fix_nhis_active_medication_future_dispensing_window.sql'))
sql(read('20260801120000_add_nhis_patient_active_medication_summary.sql'))
dates = read('20260820100000_fix_cross_facility_medicine_dispensing_dates.sql')
sql(dates.split('-- Keep the broad legacy sync core unchanged.')[0])
sql((ROOT / 'src/services/fixtures/nhis-overlap-production-20261003.sql').read_text())
for name in ['20261002110000_check_coverage_before_nhis_serving.sql','20261003120000_require_identity_for_nhis_coverage.sql','20261003130000_fix_nhis_overlap_caller_membership.sql','20261003140000_align_nhis_serving_coverage_dates.sql','20261003150000_recheck_nhis_coverage_on_claim_edit.sql']:
    sql(read(name))
if args.patched:
    sql(read('20261003160000_lock_all_nhis_coverage_identifiers.sql'))
    sql(read('20261003160000_lock_all_nhis_coverage_identifiers.sql'))
if args.final_batch:
    sql(read('20261003170000_complete_nhis_coverage_guards.sql'))
    sql(read('20261003170000_complete_nhis_coverage_guards.sql'))
sql(f"""
insert into organizations values ('{ORG}','Concurrency test');
insert into nhis_claims(id,organization_id,member_no,service_date_from,status) values
('{PRIOR}','{ORG}','12345678','2026-09-14','draft'),
('{CURRENT}','{ORG}','12345678','2026-09-14','draft');
insert into nhis_claim_medicines(claim_id,drug_code,description,prescribed_qty,served_qty,dispensed_qty,serving_status,dose,frequency,duration,dispensary_date)
select id,'PARACETAMOL','Paracetamol tablets',15,0,0,'pending','1','TDS','5 days','2026-09-14' from nhis_claims;
""")
if args.alias:
    sql(f"update nhis_claims set hin='SHARED-HIN'; update nhis_claims set member_no=null where id='{PRIOR}';")
with ThreadPoolExecutor(max_workers=1) as pool:
    first = pool.submit(sql,f"begin; select serve_nhis_claim_direct('{CURRENT}'); select pg_sleep(8); commit;")
    deadline = time.monotonic()+20
    while time.monotonic()<deadline:
        if sql("select count(*) from pg_stat_activity where wait_event='PgSleep'").stdout.strip() == '1':
            break
        if first.done():
            first.result()
            raise AssertionError('First transaction finished before overlap test')
        time.sleep(0.1)
    else:
        raise AssertionError('First transaction never reached its holding point')
    second = sql(f"select serve_nhis_claim_direct('{PRIOR}');",check=False)
    first.result()
assert second.returncode != 0 and 'Cannot serve' in second.stderr, second.stdout + second.stderr
assert sql("select count(*) from nhis_claims where status='served'").stdout.strip() == '1'
assert sql(f"select served_qty from nhis_claim_medicines where claim_id='{PRIOR}'").stdout.strip() == '0'
print('PASS: concurrent second serving rejected; first committed; second quantity remains zero.')
