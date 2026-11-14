"""Disposable container only (--network none). Verifies the branch stock transfer migration.

  docker run -d --rm --name hf-branch-transfers --network none -e POSTGRES_PASSWORD=x \
    public.ecr.aws/supabase/postgres:17.6.1.171
  python scripts/verify-branch-stock-transfers-postgres.py
  docker stop hf-branch-transfers
"""
import json
import subprocess
from pathlib import Path

C = 'hf-branch-transfers'
D = 'branch_transfer_check'
MIGRATION = Path('supabase/migrations/20261111090000_branch_stock_transfers.sql')


def psql(q, db=D, user='postgres'):
    return subprocess.run(
        ['docker', 'exec', '-i', C, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db],
        input=q, text=True, capture_output=True, timeout=60)


def sql(q, db=D):
    r = psql(q, db)
    if r.returncode:
        raise AssertionError(r.stderr + '\n' + q[:300])
    return r.stdout.strip()


def as_user(uid, q):
    """Runs q as an authenticated user. Returns (ok, stdout, stderr)."""
    script = ("begin;\nset local role authenticated;\n"
              f"select set_config('request.jwt.claim.sub', '{uid}', true);\n{q}\ncommit;")
    r = psql(script)
    return r.returncode == 0, r.stdout.strip(), r.stderr


def ok(uid, q):
    good, out, err = as_user(uid, q)
    assert good, err
    return out.splitlines()[-1] if out else ''


def fails(uid, q, expect):
    good, out, err = as_user(uid, q)
    assert not good, 'expected failure: ' + q[:100]
    assert expect.lower() in err.lower(), f'expected "{expect}" in: {err}'


def count(q):
    return int(sql(q))


# ---------------------------------------------------------------- stand-in schema
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
create table organizations(id uuid primary key, can_use_multi_branch boolean not null default false);
create table branches(id uuid primary key default gen_random_uuid(), organization_id uuid not null references organizations(id),
  name varchar(255) not null, code varchar(50), phone varchar(20), email varchar(255), address text, city varchar(100),
  region varchar(100), is_main boolean not null default false, is_active boolean not null default true);
create table users(id uuid primary key, organization_id uuid, role text, assigned_roles text[], is_active boolean,
  branch_id uuid, can_adjust_stock boolean default false, can_manage_inventory boolean default false);
create table drugs(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, name text,
  batch_number text, expiry_date date, quantity numeric(10,2), unit text, price numeric, cost_price numeric,
  supplier text, category text, description text, reorder_level numeric, status text default 'active',
  created_by uuid, updated_at timestamptz default now());
create table stock_movements(id uuid primary key default gen_random_uuid(), drug_id uuid, movement_type text,
  quantity numeric, previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text, created_by uuid,
  organization_id uuid, branch_id uuid, destination_branch_id uuid, created_at timestamptz default now(),
  constraint stock_movements_movement_type_check check (movement_type in
    ('purchase','sale','adjustment','expired','return','transfer_in','transfer_out')));
create function public.user_organization_id() returns uuid language sql stable security definer
  as $$ select organization_id from public.users where id = auth.uid() $$;
create table audit_calls(action text, entity uuid, details jsonb);
create function public.log_audit_event(p_event_type text, p_entity_type text, p_entity_id uuid, p_action text,
  p_details jsonb default '{}', p_organization_id uuid default null) returns void language sql
  as $$ insert into audit_calls values (p_action, p_entity_id, p_details) $$;
grant select on all tables in schema public to authenticated;
""")
sql(MIGRATION.read_text(encoding='utf-8'))
sql(MIGRATION.read_text(encoding='utf-8'))  # re-running must be harmless

# ---------------------------------------------------------------- fixtures
O = '00000000-0000-0000-0000-000000000001'
O2 = '00000000-0000-0000-0000-000000000002'
MAIN, B1, B2, OB = ['00000000-0000-0000-0000-0000000b00%02d' % i for i in (1, 2, 3, 9)]
ADMIN, PHARM_MAIN, MGR_B1, MGR_B2, MGR_ORG, CASHIER, PHARM_B1, OTHER_ADMIN, INACTIVE = [
    '00000000-0000-0000-0000-0000000000%02d' % i for i in (1, 2, 3, 4, 5, 6, 7, 8, 9)]
PARA, AMOX, EXPD, OTHERDRUG = ['00000000-0000-0000-0000-00000000d0%02d' % i for i in (1, 2, 3, 9)]
sql(f"""
insert into organizations values ('{O}', true), ('{O2}', false);
insert into branches(id, organization_id, name, is_main) values
  ('{MAIN}','{O}','Main Store',true), ('{B1}','{O}','Kumasi Branch',false),
  ('{B2}','{O}','Tema Branch',false), ('{OB}','{O2}','Other Org Main',true);
insert into users(id, organization_id, role, is_active, branch_id) values
  ('{ADMIN}','{O}','admin',true,null),
  ('{PHARM_MAIN}','{O}','pharmacist',true,'{MAIN}'),
  ('{MGR_B1}','{O}','branch_manager',true,'{B1}'),
  ('{MGR_B2}','{O}','branch_manager',true,'{B2}'),
  ('{MGR_ORG}','{O}','branch_manager',true,null),
  ('{CASHIER}','{O}','cashier',true,'{MAIN}'),
  ('{PHARM_B1}','{O}','pharmacist',true,'{B1}'),
  ('{OTHER_ADMIN}','{O2}','admin',true,null),
  ('{INACTIVE}','{O}','admin',false,null);
insert into drugs(id, organization_id, branch_id, name, batch_number, expiry_date, quantity, unit, price, cost_price)
values
  ('{PARA}','{O}','{MAIN}','Paracetamol 500mg','B-100','2030-01-01',100,'tab',2,1),
  ('{AMOX}','{O}','{MAIN}','Amoxicillin 250mg','B-200','2030-01-01',50,'cap',5,3),
  ('{EXPD}','{O}','{MAIN}','Old Syrup','B-300','2020-01-01',10,'btl',9,6),
  ('{OTHERDRUG}','{O2}','{OB}','Foreign Drug','F-1','2030-01-01',10,'tab',1,1);
""")


def qty(drug_id):
    return float(sql(f"select quantity from drugs where id = '{drug_id}'"))


def total_stock(name):
    return float(sql(f"select coalesce(sum(quantity),0) from drugs where organization_id='{O}' and name='{name}'"))


def items_json(*pairs):
    return json.dumps([{'drug_id': d, 'quantity': q} for d, q in pairs])


def dispatch(uid, src, dst, items, notes='null'):
    return ok(uid, f"select public.create_branch_stock_transfer('{src}','{dst}','{items}'::jsonb,{notes});")


# ---------------------------------------------------------------- dispatch
res = json.loads(dispatch(PHARM_MAIN, MAIN, B1, items_json((PARA, 30), (AMOX, 10)), "'Weekly top-up'"))
T1 = res['transfer_id']
assert res['status'] == 'pending' and res['transfer_number'].startswith('TRF-') and res['lines'] == 2, res
assert qty(PARA) == 70 and qty(AMOX) == 40, 'stock leaves the source on dispatch'
assert count(f"select count(*) from stock_movements where reference_id='{T1}' and movement_type='transfer_out' and branch_id='{MAIN}' and destination_branch_id='{B1}'") == 2
assert count("select count(*) from audit_calls where action='dispatched'") == 1
assert count(f"select count(*) from drugs where branch_id='{B1}'") == 0, 'nothing reaches the destination until it is confirmed'

# duplicate lines are added together; over-ordering is refused; expired and foreign stock refused
T_dup = json.loads(dispatch(ADMIN, MAIN, B2, items_json((PARA, 5), (PARA, 5))))['transfer_id']
assert qty(PARA) == 60 and float(sql(f"select quantity_sent from branch_stock_transfer_items where transfer_id='{T_dup}'")) == 10
fails(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((PARA, 999))}'::jsonb,null);", 'Not enough')
fails(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((EXPD, 1))}'::jsonb,null);", 'expired')
fails(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((OTHERDRUG, 1))}'::jsonb,null);", 'could not be found')
fails(ADMIN, f"select public.create_branch_stock_transfer('{B1}','{B2}','{items_json((PARA, 1))}'::jsonb,null);", 'not stocked at the sending branch')
fails(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{MAIN}','{items_json((PARA, 1))}'::jsonb,null);", 'two different branches')
fails(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{OB}','{items_json((PARA, 1))}'::jsonb,null);", 'receiving branch could not be found')
for bad in ('[]', '{}', '[{"drug_id":"x","quantity":1}]', f'[{{"drug_id":"{PARA}","quantity":0}}]',
            f'[{{"drug_id":"{PARA}","quantity":-3}}]', f'[{{"drug_id":"{PARA}","quantity":"1e3"}}]',
            f'[{{"drug_id":"{PARA}","quantity":1.234}}]'):
    good, _, err = as_user(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{bad}'::jsonb,null);")
    assert not good, 'bad payload accepted: ' + bad
fails(ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{B1}',null,null);", 'between 1 and 100')
assert qty(PARA) == 60, 'refused dispatches leave stock untouched'

# who may send
fails(CASHIER, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((PARA, 1))}'::jsonb,null);", 'inventory staff')
fails(PHARM_B1, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((PARA, 1))}'::jsonb,null);", 'your own branch')
fails(INACTIVE, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((PARA, 1))}'::jsonb,null);", 'inventory staff')
fails(OTHER_ADMIN, f"select public.create_branch_stock_transfer('{MAIN}','{B1}','{items_json((PARA, 1))}'::jsonb,null);", 'could not be found')

# ---------------------------------------------------------------- receive
item_rows = sql(f"select id || '|' || medicine_name || '|' || quantity_sent from branch_stock_transfer_items where transfer_id='{T1}' order by medicine_name").splitlines()
amox_item, para_item = [r.split('|')[0] for r in item_rows]
fails(PHARM_B1, f"select public.receive_branch_stock_transfer('{T1}',null,null);", 'administrator or the receiving branch manager')
fails(MGR_B2, f"select public.receive_branch_stock_transfer('{T1}',null,null);", 'administrator or the receiving branch manager')
fails(PHARM_MAIN, f"select public.receive_branch_stock_transfer('{T1}',null,null);", 'administrator or the receiving branch manager')
fails(OTHER_ADMIN, f"select public.receive_branch_stock_transfer('{T1}',null,null);", 'Transfer not found')
# partial receipt: 25 of 30 paracetamol, all 10 amoxicillin
partial = json.dumps([{'item_id': para_item, 'quantity_received': 25}, {'item_id': amox_item, 'quantity_received': 10}])
fails(MGR_B1, f"select public.receive_branch_stock_transfer('{T1}','{json.dumps([{'item_id': para_item, 'quantity_received': 31}, {'item_id': amox_item, 'quantity_received': 10}])}'::jsonb,null);", 'cannot be more than')
fails(MGR_B1, f"select public.receive_branch_stock_transfer('{T1}','{json.dumps([{'item_id': para_item, 'quantity_received': 5}])}'::jsonb,null);", 'every line')
fails(MGR_B1, f"select public.receive_branch_stock_transfer('{T1}','{json.dumps([{'item_id': para_item, 'quantity_received': 1}, {'item_id': para_item, 'quantity_received': 1}])}'::jsonb,null);", 'do not match')
fails(MGR_B1, f"select public.receive_branch_stock_transfer('{T1}','{json.dumps([{'item_id': para_item, 'quantity_received': 0}, {'item_id': amox_item, 'quantity_received': 0}])}'::jsonb,null);", 'Nothing was received')
assert qty(PARA) == 60 and count(f"select count(*) from drugs where branch_id='{B1}'") == 0, 'failed receipts change nothing'
r2 = json.loads(ok(MGR_B1, f"select public.receive_branch_stock_transfer('{T1}','{partial}'::jsonb,'one blister pack damaged');"))
assert r2['status'] == 'received' and r2['discrepancy'] is True, r2
assert qty(PARA) == 65, 'the 5 short go back to the source branch'
assert float(sql(f"select quantity from drugs where branch_id='{B1}' and name='Paracetamol 500mg'")) == 25
assert float(sql(f"select quantity from drugs where branch_id='{B1}' and name='Amoxicillin 250mg'")) == 10
assert sql(f"select batch_number from drugs where branch_id='{B1}' and name='Paracetamol 500mg'") == 'B-100', 'batch and expiry carry over'
assert count(f"select count(*) from stock_movements where reference_id='{T1}' and movement_type='transfer_in'") == 3  # 2 received + 1 return
fails(MGR_B1, f"select public.receive_branch_stock_transfer('{T1}',null,null);", 'already received')
fails(ADMIN, f"select public.cancel_branch_stock_transfer('{T1}','changed my mind');", 'already received')
fails(ADMIN, f"select public.reject_branch_stock_transfer('{T1}','too late for this');", 'already received')

# receiving into an existing batch adds to it; a branch manager with no branch (org-wide) may confirm
r3 = json.loads(ok(MGR_ORG, f"select public.receive_branch_stock_transfer('{T_dup}',null,null);"))
assert r3['discrepancy'] is False
assert float(sql(f"select quantity from drugs where branch_id='{B2}' and name='Paracetamol 500mg'")) == 10
T3 = json.loads(dispatch(ADMIN, MAIN, B1, items_json((PARA, 5))))['transfer_id']
ok(ADMIN, f"select public.receive_branch_stock_transfer('{T3}',null,null);")
assert float(sql(f"select quantity from drugs where branch_id='{B1}' and name='Paracetamol 500mg'")) == 30, '25 + 5 in the same batch'
assert count(f"select count(*) from drugs where branch_id='{B1}' and name='Paracetamol 500mg'") == 1

# ---------------------------------------------------------------- branch to branch
before_b1 = float(sql(f"select quantity from drugs where branch_id='{B1}' and name='Amoxicillin 250mg'"))
B1_AMOX = sql(f"select id from drugs where branch_id='{B1}' and name='Amoxicillin 250mg'")
T4 = json.loads(dispatch(PHARM_B1, B1, B2, items_json((B1_AMOX, 4))))['transfer_id']
assert float(sql(f"select quantity from drugs where id='{B1_AMOX}'")) == before_b1 - 4
ok(MGR_B2, f"select public.receive_branch_stock_transfer('{T4}',null,null);")
assert float(sql(f"select quantity from drugs where branch_id='{B2}' and name='Amoxicillin 250mg'")) == 4

# ---------------------------------------------------------------- reject and cancel return the stock
before = qty(AMOX)
T5 = json.loads(dispatch(PHARM_MAIN, MAIN, B1, items_json((AMOX, 7))))['transfer_id']
assert qty(AMOX) == before - 7
fails(MGR_B1, f"select public.reject_branch_stock_transfer('{T5}','no');", '5 to 500')
fails(PHARM_B1, f"select public.reject_branch_stock_transfer('{T5}','not ours');", 'receiving branch manager')
ok(MGR_B1, f"select public.reject_branch_stock_transfer('{T5}','Wrong strength sent');")
assert qty(AMOX) == before and sql(f"select status from branch_stock_transfers where id='{T5}'") == 'rejected'
T6 = json.loads(dispatch(PHARM_MAIN, MAIN, B1, items_json((AMOX, 3))))['transfer_id']
fails(PHARM_B1, f"select public.cancel_branch_stock_transfer('{T6}','not mine to cancel');", 'Only the sender')
fails(MGR_B2, f"select public.cancel_branch_stock_transfer('{T6}','not my branch');", 'Only the sender')
ok(PHARM_MAIN, f"select public.cancel_branch_stock_transfer('{T6}','Sent by mistake');")
assert qty(AMOX) == before and sql(f"select status from branch_stock_transfers where id='{T6}'") == 'cancelled'
T7 = json.loads(dispatch(PHARM_MAIN, MAIN, B1, items_json((AMOX, 2))))['transfer_id']
ok(ADMIN, f"select public.cancel_branch_stock_transfer('{T7}','Admin recalled it');")
T8 = json.loads(dispatch(PHARM_MAIN, MAIN, B1, items_json((AMOX, 2))))['transfer_id']
mgr_main = '00000000-0000-0000-0000-0000000000aa'
sql(f"insert into users(id, organization_id, role, is_active, branch_id) values ('{mgr_main}','{O}','branch_manager',true,'{MAIN}');")
ok(mgr_main, f"select public.cancel_branch_stock_transfer('{T8}','Sending branch manager recalled it');")
assert qty(AMOX) == before

# ---------------------------------------------------------------- stock is conserved
for name in ('Paracetamol 500mg', 'Amoxicillin 250mg'):
    start = {'Paracetamol 500mg': 100, 'Amoxicillin 250mg': 50}[name]
    assert total_stock(name) == start, (name, total_stock(name))
net = float(sql(f"select coalesce(sum(quantity),0) from stock_movements where organization_id='{O}' and movement_type in ('transfer_in','transfer_out')"))
assert net == 0, 'every transfer_out is matched by transfer_in rows'

# ---------------------------------------------------------------- read access and no direct writes
assert count(f"select count(*) from branch_stock_transfers where organization_id = '{O2}'") == 0
assert ok(OTHER_ADMIN, 'select count(*) from public.branch_stock_transfers;') == '0', 'another pharmacy sees none of these transfers'
assert int(ok(PHARM_B1, 'select count(*) from public.branch_stock_transfers;')) == 8
assert int(ok(PHARM_B1, 'select count(*) from public.branch_stock_transfer_items;')) >= 8
for stmt in ("insert into public.branch_stock_transfers(organization_id,transfer_number,source_branch_id,destination_branch_id,created_by) "
             f"values ('{O}','X-1','{MAIN}','{B1}','{ADMIN}');",
             "update public.branch_stock_transfers set status='received';",
             'delete from public.branch_stock_transfers;',
             "update public.branch_stock_transfer_items set quantity_sent = 999;"):
    good, _, err = as_user(ADMIN, stmt)
    assert not good and 'permission denied' in err.lower(), stmt
good, _, err = as_user(ADMIN, 'select public.branch_transfer_actor();')
assert not good and 'permission denied' in err.lower(), 'internal helpers are not callable by clients'
good, _, err = as_user(ADMIN, f"select public.branch_transfer_return_stock('{T5}','{ADMIN}','x');")
assert not good and 'permission denied' in err.lower()
r = psql('begin; set local role anon; select public.create_pharmacy_branch(\'Nope\');', D)
assert r.returncode and 'permission denied' in r.stderr.lower(), 'anon cannot call the functions'

# ---------------------------------------------------------------- branch creation
new_branch = json.loads(ok(ADMIN, "select public.create_pharmacy_branch('Accra Branch','ACC','0240000000','a@b.com','12 High St','Accra','Greater Accra');"))
assert new_branch['is_main'] is False and new_branch['organization_id'] == O and new_branch['name'] == 'Accra Branch'
mgr_branch = json.loads(ok(MGR_B1, "select public.create_pharmacy_branch('  Takoradi Branch ');"))
assert mgr_branch['name'] == 'Takoradi Branch' and mgr_branch['is_main'] is False
fails(PHARM_MAIN, "select public.create_pharmacy_branch('Cape Coast Branch');", 'administrator or branch manager')
fails(CASHIER, "select public.create_pharmacy_branch('Cape Coast Branch');", 'administrator or branch manager')
fails(INACTIVE, "select public.create_pharmacy_branch('Cape Coast Branch');", 'administrator or branch manager')
fails(ADMIN, "select public.create_pharmacy_branch('accra branch');", 'already exists')
fails(ADMIN, "select public.create_pharmacy_branch('Other','acc');", 'already exists')
fails(ADMIN, "select public.create_pharmacy_branch('x');", '2 to 120')
fails(ADMIN, "select public.create_pharmacy_branch('Okay','" + 'c' * 51 + "');", 'too long')
# multi-branch is a platform switch: a pharmacy without it cannot add a second branch
fails(OTHER_ADMIN, "select public.create_pharmacy_branch('Accra Branch');", 'Multi-branch is not enabled')
sql(f"update organizations set can_use_multi_branch = true where id = '{O2}';")
other_branch = json.loads(ok(OTHER_ADMIN, "select public.create_pharmacy_branch('Accra Branch');"))
assert other_branch['organization_id'] == O2, 'the same name is fine in another pharmacy once multi-branch is on'
# a pharmacy with no branch yet may create its first one even without the switch
O3 = '00000000-0000-0000-0000-000000000003'
FIRST = '00000000-0000-0000-0000-0000000000f1'
sql(f"insert into organizations values ('{O3}', false); insert into users(id, organization_id, role, is_active) values ('{FIRST}','{O3}','admin',true);")
ok(FIRST, "select public.create_pharmacy_branch('First Branch');")
fails(FIRST, "select public.create_pharmacy_branch('Second Branch');", 'Multi-branch is not enabled')
assert count(f"select count(*) from branches where organization_id='{O}' and is_main") == 1, 'only one main branch'
assert count("select count(*) from audit_calls where action = 'created'") == 4

print('PASS dispatch, receive (full and partial), reject, cancel, branch creation, permissions, isolation and stock conservation')
