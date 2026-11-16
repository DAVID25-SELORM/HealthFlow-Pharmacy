"""Disposable container only (--network none). Verifies the branch scope row-level-security migration (BRANCH-002).

  docker run -d --rm --name hf-branch-scope --network none -e POSTGRES_PASSWORD=x \
    public.ecr.aws/supabase/postgres:17.6.1.171
  python scripts/verify-branch-scope-rls-postgres.py
  docker stop hf-branch-scope
"""
import subprocess
from pathlib import Path

C = 'hf-branch-scope'
D = 'branch_scope_check'
MIGRATION = Path('supabase/migrations/20261116090000_branch_scope_rls.sql')


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
    """Runs q as a signed-in user (role authenticated). Returns (ok, stdout, stderr)."""
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
    assert not good, 'expected failure: ' + q[:100]
    assert expect.lower() in err.lower(), f'expected "{expect}" in: {err}'


def seen(uid, q):
    """Number the user can see for a 'select count(*) ...' query."""
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
create table branches(id uuid primary key, organization_id uuid not null references organizations(id),
  name text, is_main boolean not null default false, is_active boolean not null default true);
create table users(id uuid primary key, organization_id uuid, role varchar, assigned_roles text[], branch_id uuid);
create table drugs(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid, name text,
  quantity numeric default 0, status text default 'active', reorder_level numeric default 10, expiry_date date);
create table sales(id uuid primary key default gen_random_uuid(), organization_id uuid, branch_id uuid,
  payment_status text default 'completed', net_amount numeric default 0);
create table sale_items(id uuid primary key default gen_random_uuid(), organization_id uuid, sale_id uuid references sales(id),
  drug_id uuid, quantity numeric);
create table stock_movements(id uuid primary key default gen_random_uuid(), organization_id uuid, drug_id uuid,
  movement_type text, branch_id uuid, destination_branch_id uuid);
create table branch_stock_transfers(id uuid primary key default gen_random_uuid(), organization_id uuid,
  source_branch_id uuid, destination_branch_id uuid, status text default 'pending');
create table branch_stock_transfer_items(id uuid primary key default gen_random_uuid(), organization_id uuid,
  transfer_id uuid references branch_stock_transfers(id), medicine_name text);
create function public.user_organization_id() returns uuid language sql stable security definer
  as $$ select organization_id from public.users where id = auth.uid() $$;

-- the existing organisation-wide rules, as they are in production
alter table drugs enable row level security; alter table sales enable row level security;
alter table sale_items enable row level security; alter table stock_movements enable row level security;
alter table branch_stock_transfers enable row level security; alter table branch_stock_transfer_items enable row level security;
create policy drugs_select_same_org on drugs for select to authenticated using (organization_id = public.user_organization_id());
create policy drugs_insert_staff on drugs for insert to authenticated with check (organization_id = public.user_organization_id());
create policy drugs_update_staff on drugs for update to authenticated using (organization_id = public.user_organization_id()) with check (organization_id = public.user_organization_id());
create policy sales_select_same_org on sales for select to authenticated using (organization_id = public.user_organization_id());
create policy sales_insert_staff on sales for insert to authenticated with check (organization_id = public.user_organization_id());
create policy sales_update_staff on sales for update to authenticated using (organization_id = public.user_organization_id()) with check (organization_id = public.user_organization_id());
create policy sale_items_select_same_org on sale_items for select to authenticated using (organization_id = public.user_organization_id());
create policy movements_select_same_org on stock_movements for select to authenticated using (organization_id = public.user_organization_id());
create policy transfers_select_org on branch_stock_transfers for select to authenticated using (organization_id = public.user_organization_id());
create policy transfer_items_select_org on branch_stock_transfer_items for select to authenticated using (organization_id = public.user_organization_id());
grant select, insert, update, delete on all tables in schema public to authenticated;

-- the alert views run with the caller's rights, as in production
create view low_stock_drugs with (security_invoker = true) as
  select id, name, quantity, reorder_level from drugs where status = 'active' and coalesce(quantity,0) <= coalesce(reorder_level,0);
grant select on low_stock_drugs to authenticated;

-- stands in for the refund function: security definer, updates the sale as the table owner
create function public.refund_stub(p_sale uuid) returns void language plpgsql security definer set search_path = public as $$
begin update public.sales set payment_status = 'refunded' where id = p_sale; end $$;
grant execute on function public.refund_stub(uuid) to authenticated;
""")

ROLLBACK_SQL = """
begin;
drop trigger if exists sales_branch_guard on public.sales;
drop function if exists public.guard_sale_branch_update();
drop policy if exists branch_stock_transfer_items_branch_scope on public.branch_stock_transfer_items;
drop policy if exists branch_stock_transfers_branch_scope on public.branch_stock_transfers;
drop policy if exists stock_movements_branch_scope on public.stock_movements;
drop policy if exists sale_items_branch_scope on public.sale_items;
drop policy if exists sales_branch_scope on public.sales;
drop policy if exists drugs_branch_scope on public.drugs;
drop function if exists public.user_branch_scope();
notify pgrst, 'reload schema';
commit;
"""

# ---------------------------------------------------------------- fixtures
def u(n):
    return '00000000-0000-0000-0000-0000000000%02d' % n


O, O2, O3 = [f'00000000-0000-0000-0000-00000000a0{i:02d}' for i in (1, 2, 3)]
MAIN, B1, B2, OB, XB, XB2 = [f'00000000-0000-0000-0000-0000000b00{i:02d}' for i in (1, 2, 3, 4, 5, 6)]
ADMIN, ADMIN_BRANCH, MGR_B1, CASHIER_MAIN, DUAL, MGR_ORG, SINGLE, NOMULTI, OTHER_ORG_ADMIN = [u(i) for i in range(1, 10)]
sql(f"""
insert into organizations values ('{O}', true), ('{O2}', true), ('{O3}', false);
insert into branches(id, organization_id, name, is_main) values
  ('{MAIN}','{O}','Main Store',true), ('{B1}','{O}','Lapaz Branch',false), ('{B2}','{O}','Tema Branch',false),
  ('{OB}','{O2}','Single Branch',true),
  ('{XB}','{O3}','Pharmacy A',true), ('{XB2}','{O3}','Pharmacy B',false);
insert into users(id, organization_id, role, assigned_roles, branch_id) values
  ('{ADMIN}','{O}','admin','{{admin}}',null),
  ('{ADMIN_BRANCH}','{O}','admin','{{admin}}','{B1}'),
  ('{MGR_B1}','{O}','branch_manager','{{branch_manager}}','{B1}'),
  ('{CASHIER_MAIN}','{O}','cashier','{{cashier}}','{MAIN}'),
  ('{DUAL}','{O}','cashier','{{cashier,admin}}','{B1}'),
  ('{MGR_ORG}','{O}','branch_manager','{{branch_manager}}',null),
  ('{SINGLE}','{O2}','cashier','{{cashier}}','{OB}'),
  ('{NOMULTI}','{O3}','cashier','{{cashier}}','{XB}'),
  ('{OTHER_ORG_ADMIN}','{O2}','admin','{{admin}}',null);
-- Org O: main has 3 drugs, Lapaz has 1, one legacy drug has no branch
insert into drugs(organization_id, branch_id, name, quantity, reorder_level) values
  ('{O}','{MAIN}','Main A',5,10), ('{O}','{MAIN}','Main B',50,10), ('{O}','{MAIN}','Main C',50,10),
  ('{O}','{B1}','Lapaz A',2,10), ('{O}',null,'Legacy no-branch',1,10);
-- Org O2 (one branch, all stock without a branch) and Org O3 (Multi-branch off)
insert into drugs(organization_id, branch_id, name, quantity, reorder_level)
  select '{O2}', null, 'Single ' || g, 1, 10 from generate_series(1,4) g;
insert into drugs(organization_id, branch_id, name, quantity, reorder_level) values
  ('{O3}','{XB}','Nomulti A',1,10), ('{O3}','{XB2}','Nomulti B',1,10);
insert into sales(id, organization_id, branch_id) values
  ('00000000-0000-0000-0000-00000000c001','{O}','{MAIN}'), ('00000000-0000-0000-0000-00000000c002','{O}','{MAIN}'),
  ('00000000-0000-0000-0000-00000000c003','{O}','{B1}');
insert into sale_items(organization_id, sale_id, quantity) values
  ('{O}','00000000-0000-0000-0000-00000000c001',1), ('{O}','00000000-0000-0000-0000-00000000c002',2),
  ('{O}','00000000-0000-0000-0000-00000000c003',3);
insert into stock_movements(organization_id, movement_type, branch_id, destination_branch_id) values
  ('{O}','sale','{MAIN}',null), ('{O}','sale','{MAIN}',null), ('{O}','sale','{B1}',null),
  ('{O}','transfer_out','{MAIN}','{B1}'), ('{O}','transfer_out','{MAIN}','{B2}'), ('{O}','adjustment',null,null);
insert into branch_stock_transfers(id, organization_id, source_branch_id, destination_branch_id) values
  ('00000000-0000-0000-0000-00000000e001','{O}','{MAIN}','{B1}'), ('00000000-0000-0000-0000-00000000e002','{O}','{MAIN}','{B2}');
insert into branch_stock_transfer_items(organization_id, transfer_id, medicine_name) values
  ('{O}','00000000-0000-0000-0000-00000000e001','To Lapaz'), ('{O}','00000000-0000-0000-0000-00000000e002','To Tema');
""")

# ---------------------------------------------------------------- before the migration: everyone sees everything
assert seen(MGR_B1, 'select count(*) from drugs') == 5, 'before: organisation-wide'

# ---------------------------------------------------------------- apply (twice: re-running must be harmless)
sql(MIGRATION.read_text(encoding='utf-8'))
sql(MIGRATION.read_text(encoding='utf-8'))

# ---------------------------------------------------------------- who is limited
def scope_of(uid):
    return ok(uid, 'select coalesce(public.user_branch_scope()::text, \'none\')')

assert scope_of(MGR_B1) == B1, 'branch manager of Lapaz is limited to Lapaz'
assert scope_of(CASHIER_MAIN) == MAIN
for who, why in ((ADMIN, 'admin'), (ADMIN_BRANCH, 'admin who belongs to a branch'), (DUAL, 'admin among assigned roles'),
                 (MGR_ORG, 'no branch'), (SINGLE, 'single-branch pharmacy'), (NOMULTI, 'Multi-branch off')):
    assert scope_of(who) == 'none', why + ' must not be limited'

# ---------------------------------------------------------------- stock
assert seen(MGR_B1, 'select count(*) from drugs') == 2, 'Lapaz stock plus the legacy no-branch row, not the main store'
assert ok(MGR_B1, "select string_agg(name, ',' order by name) from drugs") == 'Lapaz A,Legacy no-branch'
assert seen(CASHIER_MAIN, 'select count(*) from drugs') == 4, 'main store stock plus the legacy row'
assert seen(ADMIN, 'select count(*) from drugs') == 5, 'administrator sees the whole pharmacy'
assert seen(ADMIN_BRANCH, 'select count(*) from drugs') == 5
assert seen(DUAL, 'select count(*) from drugs') == 5
assert seen(MGR_ORG, 'select count(*) from drugs') == 5
assert seen(SINGLE, 'select count(*) from drugs') == 4, 'single-branch pharmacy keeps its no-branch stock'
assert seen(NOMULTI, 'select count(*) from drugs') == 2
assert seen(OTHER_ORG_ADMIN, 'select count(*) from drugs') == 4, 'other organisations stay isolated'

# the alert view follows the same rule, so the dashboard and bell are protected at the source
assert seen(MGR_B1, 'select count(*) from low_stock_drugs') == 2
assert seen(ADMIN, 'select count(*) from low_stock_drugs') == 3, 'Main A, Lapaz A and the legacy row are low'
assert seen(CASHIER_MAIN, 'select count(*) from low_stock_drugs') == 2

# ---------------------------------------------------------------- writes
fails(MGR_B1, f"insert into drugs(organization_id, branch_id, name) values ('{O}','{MAIN}','Smuggled');", 'row-level security')
assert ok(MGR_B1, f"with i as (insert into drugs(organization_id, branch_id, name) values ('{O}','{B1}','Own branch add') returning 1) select count(*) from i") == '1'
assert ok(MGR_B1, f"with x as (update drugs set quantity = 999 where name = 'Main A' returning 1) select count(*) from x") == '0', 'cannot change main store stock'
assert sql("select count(*) from drugs where name = 'Own branch add'") == '1', 'the own-branch insert was saved'
assert float(sql("select quantity from drugs where name = 'Main A'")) == 5
assert ok(MGR_B1, f"with x as (update drugs set quantity = 7 where name = 'Lapaz A' returning 1) select count(*) from x") == '1'
fails(MGR_B1, f"update drugs set branch_id = '{MAIN}' where name = 'Lapaz A';", 'row-level security')
assert ok(ADMIN, f"with x as (update drugs set quantity = 6 where name = 'Main A' returning 1) select count(*) from x") == '1', 'administrator unaffected'

# ---------------------------------------------------------------- sales and lines
assert seen(MGR_B1, 'select count(*) from sales') == 1
assert seen(CASHIER_MAIN, 'select count(*) from sales') == 2
assert seen(ADMIN, 'select count(*) from sales') == 3
assert seen(MGR_B1, 'select count(*) from sale_items') == 1, 'sale lines follow their sale'
assert seen(CASHIER_MAIN, 'select count(*) from sale_items') == 2
assert seen(ADMIN, 'select count(*) from sale_items') == 3
assert seen(SINGLE, 'select count(*) from sales') == 0

# ---------------------------------------------------------------- stock movements and transfers
assert seen(MGR_B1, 'select count(*) from stock_movements') == 3, 'Lapaz sale, the transfer into Lapaz, and the no-branch row'
assert seen(CASHIER_MAIN, 'select count(*) from stock_movements') == 5, 'its own sales and both transfers it sent, plus the no-branch row'
assert seen(ADMIN, 'select count(*) from stock_movements') == 6
assert seen(MGR_B1, 'select count(*) from branch_stock_transfers') == 1, 'only transfers that involve Lapaz'
assert ok(MGR_B1, "select string_agg(medicine_name, ',') from branch_stock_transfer_items") == 'To Lapaz'
assert seen(CASHIER_MAIN, 'select count(*) from branch_stock_transfers') == 2, 'the main store is the sender of both'
assert seen(ADMIN, 'select count(*) from branch_stock_transfers') == 2
assert seen(ADMIN, 'select count(*) from branch_stock_transfer_items') == 2

# ---------------------------------------------------------------- refunds: a sale of another branch cannot be changed
MAIN_SALE, B1_SALE = '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c003'
fails(MGR_B1, f"select public.refund_stub('{MAIN_SALE}');", 'only change sales of your own branch')
assert sql(f"select payment_status from sales where id = '{MAIN_SALE}'") == 'completed'
ok(MGR_B1, f"select public.refund_stub('{B1_SALE}');")
assert sql(f"select payment_status from sales where id = '{B1_SALE}'") == 'refunded', 'own-branch refund still works'
ok(ADMIN, f"select public.refund_stub('{MAIN_SALE}');")
assert sql(f"select payment_status from sales where id = '{MAIN_SALE}'") == 'refunded', 'administrator may refund any branch'
sql(f"update sales set payment_status = 'completed' where id = '{MAIN_SALE}';")  # service/owner access is untouched
sql(f"update sales set payment_status = 'completed' where id = '{B1_SALE}';")

# ---------------------------------------------------------------- the rule follows the number of active branches
sql(f"update branches set is_active = false where id = '{B2}';")
assert seen(MGR_B1, 'select count(*) from drugs') == 3, 'two active branches (main, Lapaz): still limited (Lapaz A, Own branch add, legacy)'
sql(f"update branches set is_active = false where id = '{B1}';")
assert scope_of(MGR_B1) == 'none', 'one active branch left: nothing to keep apart'
assert seen(MGR_B1, 'select count(*) from drugs') == 6
sql(f"update branches set is_active = true where id in ('{B1}', '{B2}');")
assert scope_of(MGR_B1) == B1

# ---------------------------------------------------------------- privileges
assert sql("select has_function_privilege('anon','public.user_branch_scope()','EXECUTE')") == 'f'
assert sql("select has_function_privilege('authenticated','public.user_branch_scope()','EXECUTE')") == 't'
assert sql("select has_function_privilege('anon','public.guard_sale_branch_update()','EXECUTE')") == 'f'
assert sql("select count(*) from pg_policies where schemaname='public' and policyname like '%branch_scope' and permissive = 'RESTRICTIVE'") == '6'
assert sql("select count(*) from pg_trigger where tgname='sales_branch_guard' and not tgisinternal") == '1'

# ---------------------------------------------------------------- nothing existing was changed
assert sql("select count(*) from pg_policies where schemaname='public' and policyname in ('drugs_select_same_org','sales_select_same_org','sale_items_select_same_org')") == '3'

# ---------------------------------------------------------------- rollback restores the old behaviour
sql(ROLLBACK_SQL)
assert seen(MGR_B1, 'select count(*) from drugs') == 6, 'after rollback: organisation-wide again'
assert sql("select count(*) from pg_policies where policyname like '%branch_scope'") == '0'
assert sql("select to_regprocedure('public.user_branch_scope()') is null") == 't'
sql(MIGRATION.read_text(encoding='utf-8'))  # and it applies cleanly again
assert scope_of(MGR_B1) == B1

print('branch scope row-level-security: all checks passed')
