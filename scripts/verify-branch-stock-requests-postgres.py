"""Disposable container only (--network none). Verifies the branch stock request migration (BRANCH-003) together with
the real confirmed-transfer (20261111090000) and branch-scope (20261116090000) migrations it builds on.

  docker run -d --rm --name hf-stock-requests --network none -e POSTGRES_PASSWORD=x \
    public.ecr.aws/supabase/postgres:17.6.1.171
  python scripts/verify-branch-stock-requests-postgres.py
  docker stop hf-stock-requests
"""
import json
import subprocess
from pathlib import Path

C = 'hf-stock-requests'
D = 'stock_requests_check'
TRANSFERS = Path('supabase/migrations/20261111090000_branch_stock_transfers.sql')
SCOPE = Path('supabase/migrations/20261116090000_branch_scope_rls.sql')
MIGRATION = Path('supabase/migrations/20261117090000_branch_stock_requests.sql')


def psql(q, db=D, user='postgres'):
    return subprocess.run(
        ['docker', 'exec', '-i', C, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db],
        input=q, text=True, capture_output=True, timeout=120)


def sql(q, db=D):
    r = psql(q, db)
    if r.returncode:
        raise AssertionError(r.stderr + '\n' + q[:300])
    return r.stdout.strip()


def as_user(uid, q):
    q = q.strip()
    if not q.endswith(';'):
        q += ';'  # without it psql reads "... commit" as an alias and the transaction is never committed
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
    assert not good, 'expected failure: ' + q[:120]
    assert expect.lower() in err.lower(), f'expected "{expect}" in: {err}'


def seen(uid, q):
    return int(ok(uid, q))


# ---------------------------------------------------------------- stand-in schema (mirrors production)
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
  name text, code text, phone text, email text, address text, city text, region text,
  is_main boolean not null default false, is_active boolean not null default true);
create table users(id uuid primary key, organization_id uuid, role varchar, assigned_roles text[], branch_id uuid,
  is_active boolean default true, can_adjust_stock boolean default false, can_manage_inventory boolean default false,
  full_name text);
create table drugs(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, name text,
  batch_number text, expiry_date date, quantity numeric default 0, unit text, price numeric, cost_price numeric,
  supplier text, category text, description text, reorder_level numeric default 10, status text default 'active',
  created_by uuid, updated_at timestamptz);
create table sales(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid,
  payment_status text default 'completed');
create table sale_items(id uuid primary key default gen_random_uuid(), organization_id uuid, sale_id uuid references sales(id));
create table stock_movements(id uuid primary key default gen_random_uuid(), drug_id uuid, movement_type text,
  quantity numeric, previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text, created_by uuid,
  organization_id uuid, branch_id uuid, destination_branch_id uuid, created_at timestamptz default now());
create function public.user_organization_id() returns uuid language sql stable security definer
  as $$ select organization_id from public.users where id = auth.uid() $$;
create function public.log_audit_event(text, text, uuid, text, jsonb, uuid) returns void language sql as $$ select $$;
alter table drugs enable row level security; alter table sales enable row level security;
alter table sale_items enable row level security; alter table stock_movements enable row level security;
create policy drugs_select_same_org on drugs for select to authenticated using (organization_id = public.user_organization_id());
create policy sales_select_same_org on sales for select to authenticated using (organization_id = public.user_organization_id());
create policy sale_items_select_same_org on sale_items for select to authenticated using (organization_id = public.user_organization_id());
create policy movements_select_same_org on stock_movements for select to authenticated using (organization_id = public.user_organization_id());
grant select on all tables in schema public to authenticated;
""")
sql(TRANSFERS.read_text(encoding='utf-8'))
sql(SCOPE.read_text(encoding='utf-8'))


def u(n):
    return '00000000-0000-0000-0000-0000000000%02d' % n


O, O2 = '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002'
MAIN, B1, B2, OB = [f'00000000-0000-0000-0000-0000000b00{i:02d}' for i in (1, 2, 3, 4)]
ADMIN, MGR_B1, CASHIER_B1, PHARM_MAIN, MGR_B2, MGR_ORG, OTHER_ADMIN, STAFF_B1 = [u(i) for i in range(1, 9)]
sql(f"""
insert into organizations values ('{O}', true), ('{O2}', true);
insert into branches(id, organization_id, name, is_main) values
  ('{MAIN}','{O}','Main Store',true), ('{B1}','{O}','Lapaz Branch',false), ('{B2}','{O}','Tema Branch',false),
  ('{OB}','{O2}','Other Pharmacy',true);
insert into users(id, organization_id, role, assigned_roles, branch_id, full_name) values
  ('{ADMIN}','{O}','admin','{{admin}}',null,'Admin'),
  ('{MGR_B1}','{O}','branch_manager','{{branch_manager}}','{B1}','Lapaz Manager'),
  ('{CASHIER_B1}','{O}','cashier','{{cashier}}','{B1}','Lapaz Cashier'),
  ('{PHARM_MAIN}','{O}','pharmacist','{{pharmacist}}','{MAIN}','Main Pharmacist'),
  ('{MGR_B2}','{O}','branch_manager','{{branch_manager}}','{B2}','Tema Manager'),
  ('{MGR_ORG}','{O}','branch_manager','{{branch_manager}}',null,'Org Manager'),
  ('{OTHER_ADMIN}','{O2}','admin','{{admin}}',null,'Other Admin'),
  ('{STAFF_B1}','{O}','pharmacist','{{pharmacist}}','{B1}','Lapaz Pharmacist');
insert into drugs(id, organization_id, branch_id, name, batch_number, expiry_date, quantity, unit, price, cost_price) values
  ('00000000-0000-0000-0000-00000000d001','{O}','{MAIN}','Paracetamol 500mg','P1', current_date + 400, 100, 'tabs', 1.5, 0.8),
  ('00000000-0000-0000-0000-00000000d002','{O}','{MAIN}','Amoxicillin 250mg','A1', current_date + 300, 10, 'caps', 2, 1),
  ('00000000-0000-0000-0000-00000000d003','{O}','{MAIN}','Old Paracetamol','P0', current_date - 5, 40, 'tabs', 1, 1),
  ('00000000-0000-0000-0000-00000000d004','{O}','{B1}','Lapaz Own','L1', current_date + 100, 20, 'tabs', 1, 1),
  ('00000000-0000-0000-0000-00000000d005','{O}','{MAIN}','Paracetamol 500mg','P2', current_date + 200, 30, 'tabs', 1.5, 0.8);
insert into drugs(id, organization_id, branch_id, name, quantity, status) values
  ('00000000-0000-0000-0000-00000000d006','{O}','{MAIN}','Paracetamol Retired', 9, 'inactive');
""")
PARA, AMOX, OLD, LAPAZ_OWN, PARA2 = [f'00000000-0000-0000-0000-00000000d00{i}' for i in (1, 2, 3, 4, 5)]

# ---------------------------------------------------------------- apply (twice: re-running must be harmless)
sql(MIGRATION.read_text(encoding='utf-8'))
sql(MIGRATION.read_text(encoding='utf-8'))

# ---------------------------------------------------------------- the picker: stock levels only, across branches
assert seen(MGR_B1, "select count(*) from drugs where branch_id = '%s'" % MAIN) == 0, 'BRANCH-002: Lapaz manager cannot read main stock directly'
rows = ok(MGR_B1, f"select jsonb_agg(to_jsonb(t) order by t.batch_number)::text from public.search_branch_stock_for_request('{MAIN}', 'para', 12) t")
found = json.loads(rows)
assert [r['batch_number'] for r in found] == ['P1', 'P2'], 'active, in stock, not expired; the retired and expired rows are hidden'
assert set(found[0].keys()) == {'id', 'name', 'batch_number', 'expiry_date', 'unit', 'quantity'}, 'no prices or costs are exposed'
assert ok(MGR_B1, f"select count(*) from public.search_branch_stock_for_request('{MAIN}', 'p', 12)") == '0', 'a one-letter search returns nothing'
assert ok(MGR_B1, f"select count(*) from public.search_branch_stock_for_request('{MAIN}', '%', 12)") == '0'
assert ok(MGR_B1, f"select count(*) from public.search_branch_stock_for_request('{MAIN}', '%%', 12)") == '0', 'a wildcard matches nothing'
fails(CASHIER_B1, f"select * from public.search_branch_stock_for_request('{MAIN}', 'para', 12)", 'inventory staff')
fails(MGR_B1, f"select * from public.search_branch_stock_for_request('{OB}', 'para', 12)", 'could not be found')
fails(OTHER_ADMIN, f"select * from public.search_branch_stock_for_request('{MAIN}', 'para', 12)", 'could not be found')

# ---------------------------------------------------------------- ask
def make_request(uid, req_branch, src_branch, items, notes='null'):
    payload = json.dumps(items).replace("'", "''")
    return ok(uid, f"select public.create_branch_stock_request('{src_branch}', '{req_branch}', '{payload}'::jsonb, {notes})::text")


r1 = json.loads(make_request(MGR_B1, B1, MAIN, [{'drug_id': PARA, 'quantity': '40'}, {'drug_id': AMOX, 'quantity': '5'}], "'Weekend stock'"))
assert r1['status'] == 'pending' and r1['lines'] == 2 and r1['request_number'].startswith('REQ-')
assert float(sql(f"select quantity from drugs where id = '{PARA}'")) == 100, 'a request never moves stock'
assert float(sql("select sum(quantity_requested) from branch_stock_request_items")) == 45

fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B2}', '[{{\"drug_id\":\"{PARA}\",\"quantity\":\"1\"}}]'::jsonb)", 'for your own branch')
fails(MGR_B1, f"select public.create_branch_stock_request('{B1}', '{B1}', '[{{\"drug_id\":\"{LAPAZ_OWN}\",\"quantity\":\"1\"}}]'::jsonb)", 'two different branches')
fails(CASHIER_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[{{\"drug_id\":\"{PARA}\",\"quantity\":\"1\"}}]'::jsonb)", 'inventory staff')
fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[{{\"drug_id\":\"{OLD}\",\"quantity\":\"1\"}}]'::jsonb)", 'expired')
fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[{{\"drug_id\":\"{LAPAZ_OWN}\",\"quantity\":\"1\"}}]'::jsonb)", 'not stocked at')
fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[{{\"drug_id\":\"00000000-0000-0000-0000-00000000d006\",\"quantity\":\"1\"}}]'::jsonb)", 'not an active product')
fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[{{\"drug_id\":\"{PARA}\",\"quantity\":\"0\"}}]'::jsonb)", 'above zero')
fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[]'::jsonb)", 'between 1 and 100')
fails(MGR_B1, f"select public.create_branch_stock_request('{MAIN}', '{B1}', '[{{\"drug_id\":\"{PARA}\",\"quantity\":\"1\"}}]'::jsonb, '{'x' * 501}')", 'at most 500')
assert sql('select count(*) from branch_stock_requests') == '1', 'failed requests leave nothing behind'
# an administrator may ask on behalf of any branch
r_admin = json.loads(make_request(ADMIN, B2, MAIN, [{'drug_id': AMOX, 'quantity': '2'}]))
assert r_admin['status'] == 'pending'

# ---------------------------------------------------------------- who sees requests (BRANCH-002 applies)
assert seen(MGR_B1, 'select count(*) from branch_stock_requests') == 1, 'Lapaz sees its own request only'
assert seen(MGR_B2, 'select count(*) from branch_stock_requests') == 1, 'Tema sees its own request only'
assert seen(PHARM_MAIN, 'select count(*) from branch_stock_requests') == 2, 'the main store sees every request addressed to it'
assert seen(ADMIN, 'select count(*) from branch_stock_requests') == 2
assert seen(OTHER_ADMIN, 'select count(*) from branch_stock_requests') == 0, 'other pharmacies see nothing'
assert seen(MGR_B1, 'select count(*) from branch_stock_request_items') == 2, 'lines follow their request'
assert seen(MGR_B2, 'select count(*) from branch_stock_request_items') == 1

items = sql(f"select string_agg(id::text, ',' order by medicine_name) from branch_stock_request_items where request_id = '{r1['request_id']}'").split(',')
AMOX_ITEM, PARA_ITEM = items  # ordered by medicine name: Amoxicillin, Paracetamol


def approve(uid, request, lines=None, notes='null'):
    payload = 'null' if lines is None else "'" + json.dumps(lines).replace("'", "''") + "'::jsonb"
    return f"select public.approve_branch_stock_request('{request}', {payload}, {notes})::text"


# ---------------------------------------------------------------- approve: who may
fails(MGR_B1, approve(MGR_B1, r1['request_id']), 'staff of the branch being asked')
fails(MGR_B2, approve(MGR_B2, r1['request_id']), 'staff of the branch being asked')
fails(CASHIER_B1, approve(CASHIER_B1, r1['request_id']), 'inventory staff')
fails(OTHER_ADMIN, approve(OTHER_ADMIN, r1['request_id']), 'not found')
assert sql(f"select status from branch_stock_requests where id = '{r1['request_id']}'") == 'pending'

# ---------------------------------------------------------------- approve: line checks roll back completely
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id'], [{'item_id': PARA_ITEM, 'quantity_approved': '41'}, {'item_id': AMOX_ITEM, 'quantity_approved': '1'}]), 'more than the')
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id'], [{'item_id': PARA_ITEM, 'quantity_approved': '0'}, {'item_id': AMOX_ITEM, 'quantity_approved': '0'}]), 'Nothing approved')
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id'], [{'item_id': PARA_ITEM, 'quantity_approved': '5'}]), 'do not match')
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id'], [{'item_id': PARA_ITEM, 'quantity_approved': '5'}, {'item_id': PARA_ITEM, 'quantity_approved': '5'}]), 'do not match')
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id'], [{'item_id': PARA_ITEM, 'quantity_approved': 'abc'}, {'item_id': AMOX_ITEM, 'quantity_approved': '1'}]), 'zero or more')
assert sql(f"select status from branch_stock_requests where id = '{r1['request_id']}'") == 'pending'
assert sql("select count(*) from branch_stock_transfers") == '0'
assert sql(f"select count(*) from branch_stock_request_items where quantity_approved is not null") == '0', 'a failed approval saves nothing'

# stock that has gone down since the request: the approval fails whole, the request stays open
sql(f"update drugs set quantity = 3 where id = '{AMOX}';")
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id']), 'Not enough')
assert sql(f"select status from branch_stock_requests where id = '{r1['request_id']}'") == 'pending'
assert float(sql(f"select quantity from drugs where id = '{PARA}'")) == 100, 'nothing left main when the approval failed'
sql(f"update drugs set quantity = 10 where id = '{AMOX}';")

# ---------------------------------------------------------------- approve: lowered quantities, one line dropped
res = json.loads(ok(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id'],
                                        [{'item_id': PARA_ITEM, 'quantity_approved': '30'}, {'item_id': AMOX_ITEM, 'quantity_approved': '0'}], "'Only 30 spare'")))
assert res['status'] == 'approved' and res['transfer_number'].startswith('TRF-')
q = sql(f"select status || '|' || coalesce(transfer_id::text,'') || '|' || coalesce(resolved_by::text,'') || '|' || coalesce(resolution_notes,'') from branch_stock_requests where id = '{r1['request_id']}'")
assert q == f"approved|{res['transfer_id']}|{PHARM_MAIN}|Only 30 spare"
assert sql(f"select quantity_approved from branch_stock_request_items where id = '{PARA_ITEM}'") == '30.00'
assert sql(f"select quantity_approved from branch_stock_request_items where id = '{AMOX_ITEM}'") == '0.00'
t = sql(f"select status || '|' || source_branch_id || '|' || destination_branch_id || '|' || notes from branch_stock_transfers where id = '{res['transfer_id']}'")
assert t == f"pending|{MAIN}|{B1}|Request {r1['request_number']}: Only 30 spare", t
assert sql(f"select count(*) || '|' || sum(quantity_sent) from branch_stock_transfer_items where transfer_id = '{res['transfer_id']}'") == '1|30.00', 'the dropped line is not sent'
assert float(sql(f"select quantity from drugs where id = '{PARA}'")) == 70, 'the stock left the main store when approved'
assert float(sql(f"select quantity from drugs where id = '{AMOX}'")) == 10
assert sql(f"select count(*) from stock_movements where reference_id = '{res['transfer_id']}' and movement_type = 'transfer_out'") == '1'
fails(PHARM_MAIN, approve(PHARM_MAIN, r1['request_id']), 'already approved')
fails(ADMIN, f"select public.decline_branch_stock_request('{r1['request_id']}', 'too late now')", 'already approved')
fails(MGR_B1, f"select public.cancel_branch_stock_request('{r1['request_id']}', 'too late now')", 'already approved')

# the requester then confirms receipt in the ordinary way
rec = json.loads(ok(MGR_B1, f"select public.receive_branch_stock_transfer('{res['transfer_id']}', null, null)::text"))
assert rec['status'] == 'received'
assert float(sql(f"select quantity from drugs where branch_id = '{B1}' and name = 'Paracetamol 500mg'")) == 30, 'Lapaz now holds the stock'

# ---------------------------------------------------------------- decline
r2 = json.loads(make_request(MGR_B1, B1, MAIN, [{'drug_id': PARA2, 'quantity': '10'}]))
fails(MGR_B1, f"select public.decline_branch_stock_request('{r2['request_id']}', 'not mine to decline')", 'branch being asked')
fails(PHARM_MAIN, f"select public.decline_branch_stock_request('{r2['request_id']}', 'no')", '5 to 500')
d = json.loads(ok(PHARM_MAIN, f"select public.decline_branch_stock_request('{r2['request_id']}', 'Need it for Tema')::text"))
assert d['status'] == 'declined'
assert sql(f"select status || '|' || resolution_notes from branch_stock_requests where id = '{r2['request_id']}'") == 'declined|Need it for Tema'
assert float(sql(f"select quantity from drugs where id = '{PARA2}'")) == 30
fails(PHARM_MAIN, approve(PHARM_MAIN, r2['request_id']), 'already declined')

# ---------------------------------------------------------------- cancel
r3 = json.loads(make_request(MGR_B1, B1, MAIN, [{'drug_id': PARA2, 'quantity': '10'}]))
fails(MGR_B2, f"select public.cancel_branch_stock_request('{r3['request_id']}', 'not my request')", 'person who asked')  # another branch's manager
fails(PHARM_MAIN, f"select public.cancel_branch_stock_request('{r3['request_id']}', 'asked branch cannot cancel')", 'person who asked')
fails(STAFF_B1, f"select public.cancel_branch_stock_request('{r3['request_id']}', 'another cashier')", 'person who asked')
fails(MGR_B1, f"select public.cancel_branch_stock_request('{r3['request_id']}', 'no')", '5 to 500')
c = json.loads(ok(MGR_B1, f"select public.cancel_branch_stock_request('{r3['request_id']}', 'Ordered elsewhere')::text"))
assert c['status'] == 'cancelled'
fails(PHARM_MAIN, approve(PHARM_MAIN, r3['request_id']), 'already cancelled')
# a manager of the asking branch may cancel a colleague's request; an administrator may cancel any
r4 = json.loads(make_request(STAFF_B1, B1, MAIN, [{'drug_id': PARA2, 'quantity': '10'}]))
assert json.loads(ok(MGR_B1, f"select public.cancel_branch_stock_request('{r4['request_id']}', 'Duplicate request')::text"))['status'] == 'cancelled'
r5 = json.loads(make_request(MGR_B1, B1, MAIN, [{'drug_id': PARA2, 'quantity': '10'}]))
assert json.loads(ok(ADMIN, f"select public.cancel_branch_stock_request('{r5['request_id']}', 'Administrator cleared it')::text"))['status'] == 'cancelled'

# an administrator and staff with no branch can approve a request for any branch (they can send from any branch)
r6 = json.loads(make_request(MGR_B2, B2, MAIN, [{'drug_id': AMOX, 'quantity': '2'}]))
assert json.loads(ok(MGR_ORG, approve(MGR_ORG, r6['request_id'])))['status'] == 'approved'
assert json.loads(ok(ADMIN, approve(ADMIN, r_admin['request_id'])))['status'] == 'approved'
assert float(sql(f"select quantity from drugs where id = '{AMOX}'")) == 6

# ---------------------------------------------------------------- privileges and no side effects
for fn in ('search_branch_stock_for_request(uuid,text,integer)', 'create_branch_stock_request(uuid,uuid,jsonb,text)',
           'approve_branch_stock_request(uuid,jsonb,text)', 'decline_branch_stock_request(uuid,text)',
           'cancel_branch_stock_request(uuid,text)'):
    assert sql(f"select has_function_privilege('anon','public.{fn}','EXECUTE')") == 'f', fn
    assert sql(f"select has_function_privilege('authenticated','public.{fn}','EXECUTE')") == 't', fn
assert sql("select count(*) from pg_policies where schemaname='public' and policyname in ('branch_stock_requests_branch_scope','branch_stock_request_items_branch_scope') and permissive='RESTRICTIVE'") == '2'
assert sql("select has_table_privilege('authenticated','public.branch_stock_requests','INSERT')") == 'f', 'writes only through the functions'
assert sql("select has_table_privilege('authenticated','public.branch_stock_requests','UPDATE')") == 'f'
fails(MGR_B1, f"insert into branch_stock_requests(organization_id, request_number, requesting_branch_id, source_branch_id, created_by) values ('{O}','X','{B1}','{MAIN}','{MGR_B1}')", 'permission denied')

# ---------------------------------------------------------------- rollback leaves the transfers and the scope rule alone
ROLLBACK = """
begin;
drop function if exists public.cancel_branch_stock_request(uuid, text);
drop function if exists public.decline_branch_stock_request(uuid, text);
drop function if exists public.approve_branch_stock_request(uuid, jsonb, text);
drop function if exists public.create_branch_stock_request(uuid, uuid, jsonb, text);
drop function if exists public.search_branch_stock_for_request(uuid, text, integer);
drop policy if exists branch_stock_request_items_branch_scope on public.branch_stock_request_items;
drop policy if exists branch_stock_requests_branch_scope on public.branch_stock_requests;
drop table if exists public.branch_stock_request_items;
drop table if exists public.branch_stock_requests;
drop sequence if exists public.branch_stock_request_number_seq;
notify pgrst, 'reload schema';
commit;
"""
sql(ROLLBACK)
assert sql("select to_regclass('public.branch_stock_requests') is null") == 't'
assert sql("select to_regprocedure('public.create_branch_stock_transfer(uuid,uuid,jsonb,text)') is not null") == 't'
assert sql("select to_regprocedure('public.user_branch_scope()') is not null") == 't'
assert seen(MGR_B1, f"select count(*) from drugs where branch_id = '{MAIN}'") == 0, 'the scope rule still holds after rollback'
sql(MIGRATION.read_text(encoding='utf-8'))  # applies cleanly again
assert sql('select count(*) from branch_stock_requests') == '0'

print('branch stock requests: all checks passed')
