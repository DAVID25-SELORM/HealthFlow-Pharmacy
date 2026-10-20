"""Disposable container only. No network endpoints or production credentials."""
import subprocess,json,time,concurrent.futures
from pathlib import Path
C='hf-nehfams-audit-20261020'
D='nehfams_audit'
def command(db=D): return ['docker','exec','-i',C,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db]
def sql(q,ok=True,db=D):
 r=subprocess.run(command(db),input=q,text=True,capture_output=True,timeout=20)
 if ok and r.returncode: raise AssertionError(r.stderr)
 if not ok: assert r.returncode, 'Expected rejection'
 return r.stdout.strip() if ok else r.stderr
sql('create database '+D+';',db='postgres')
sql("""create table organizations(id uuid primary key);
create table branches(id uuid primary key,organization_id uuid);
create table users(id uuid primary key,organization_id uuid,branch_id uuid,role text,is_active boolean);
create table nhis_claims(id uuid primary key,organization_id uuid,branch_id uuid,member_no text,service_date_from date,ccc_no text);
create type branch_client as (organization_id uuid,branch_id uuid);
create function get_branch_sync_client(text) returns branch_client language sql as 'select null::uuid,null::uuid';
""")
for name in ['20261010090000_organization_ccc_providers.sql','20261020200000_prepare_nehfams_connection.sql','20261021090000_nehfams_test_validation_and_linkage.sql']:
 sql(Path('supabase/migrations',name).read_text())
O='00000000-0000-0000-0000-000000000001'; OTHER='00000000-0000-0000-0000-000000000002'; U='00000000-0000-0000-0000-000000000003'; B='00000000-0000-0000-0000-000000000004'; B2='00000000-0000-0000-0000-000000000005'
sql(f"insert into organizations values('{O}'),('{OTHER}'); insert into branches values('{B}','{O}'),('{B2}','{O}'); insert into users values('{U}','{O}','{B}','super_admin',true);")
def reserve(member,org=O,branch=B):return f"select reserve_ccc_attendance('{org}','{U}','{branch}','draft','{member}','NHISCARD',current_date);"
def contention(member,commit):
 a=subprocess.Popen(command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
 a.stdin.write('begin;'+reserve(member)+'\n');a.stdin.flush()
 first=json.loads(a.stdout.readline())
 with concurrent.futures.ThreadPoolExecutor() as pool:
  future=pool.submit(sql,"set application_name='nehfams_waiter';"+reserve(member),not commit)
  waiting=False
  for _ in range(40):
   if sql("select count(*) from pg_stat_activity where application_name='nehfams_waiter' and wait_event_type='Lock';")!='0':waiting=True;break
   time.sleep(.05)
  assert waiting,'Independent connection did not wait for lock'
  a.stdin.write(('commit;' if commit else 'rollback;')+'\n'+chr(92)+'q\n');a.stdin.flush();a.wait(timeout=10)
  response=future.result(timeout=15)
  if commit:assert 'unresolved' in response
  else:assert json.loads(response)['request_id']!=first['request_id']
 return first
first=contention('12345678',True);print('PASS independent duplicate reservations block, then reject')
contention('12345679',False);print('PASS rollback releases reservation; waiting connection recovers')
id=first['request_id']
sql("""create function fail_outcome() returns trigger language plpgsql as $$ begin if new.status='succeeded' then raise exception 'synthetic outcome persistence failure'; end if; return new; end $$;
create trigger fail_outcome before update on ccc_attendance_requests for each row execute function fail_outcome();""")
assert 'synthetic' in sql(f"update ccc_attendance_requests set status='succeeded' where id='{id}';",False)
assert sql(f"select status from ccc_attendance_requests where id='{id}';")=='pending'
assert 'unresolved' in sql(reserve('12345678'),False)
sql(f"update ccc_attendance_requests set status='unknown' where id='{id}'; drop trigger fail_outcome on ccc_attendance_requests;")
print('PASS failed outcome write retains durable blocking ledger')
sql(f"update ccc_attendance_requests set status='succeeded',result=jsonb_build_object('ccCode','01234') where id='{id}';")
def claim(org=O,branch=B,member='12345678',code='01234'):
 return f"insert into nhis_claims values(gen_random_uuid(),'{org}','{branch}','{member}',current_date,'{code}','{id}');"
sql(claim());assert sql('select count(*) from nhis_claims;')=='1'
for q in [claim(OTHER),claim(branch=B2),claim(member='87654321'),claim(code='99999')]:assert 'does not match' in sql(q,False)
assert sql(f"select status from ccc_attendance_requests where id='{id}';")=='succeeded'
assert json.loads(sql(reserve('12345678')))['cached'] is True
print('PASS valid linkage; mismatched claims rejected; failed claim save leaves cached attendance')
assert 'membership' in sql(reserve('12345680',OTHER),False)
assert 'Branch membership' in sql(reserve('12345680',branch=B2),False)
print('PASS tenant and branch reservation isolation')
print('PASS PostgreSQL '+sql('show server_version;'))

sql("update ccc_attendance_requests set status='not_created' where status in ('pending','unknown');")
sql(f"select configure_nehfams_connection('{O}','{U}','test','synthetic-key','synthetic-secret','123','Test Facility'); select validate_nehfams_connection('{O}','{U}','test',1,'1FA',false); select activate_nehfams_test('{O}','{U}');")
contention('12345681',True)
contention('12345682',False)
print('PASS independent NeHFAMS test duplicate and rollback scenarios')
