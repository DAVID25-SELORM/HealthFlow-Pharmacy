// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('posts every linked line atomically, rejects missing/cross-tenant links and prevents double posting', async () => {
  const db = new PGlite()
  const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  try {
    await db.exec(`
      create role authenticated; create role anon; create schema auth;
      create function auth.uid() returns uuid language sql as $$ select '${id(1)}'::uuid $$;
      create function user_organization_id() returns uuid language sql as $$ select '${id(2)}'::uuid $$;
      create function user_can_approve_purchases() returns boolean language sql as $$ select true $$;
      create table purchases (id uuid primary key, organization_id uuid, branch_id uuid, status text, purchase_number text, invoice_number text, updated_at timestamptz);
      create table drugs (id uuid primary key, organization_id uuid, branch_id uuid, quantity numeric, brand_name text, generic_name text, sale_on_return boolean, batch_number text, expiry_date date, cost_price numeric, updated_at timestamptz);
      create table purchase_items (id uuid primary key, purchase_id uuid, drug_id uuid, drug_name text, quantity numeric, received_quantity numeric default 0, brand_name text, generic_name text, sale_on_return boolean, batch_number text, expiry_date date, unit_cost numeric);
      create table stock_movements (drug_id uuid, movement_type text, quantity numeric, previous_quantity numeric, new_quantity numeric, reference_id uuid, notes text, created_by uuid, organization_id uuid, created_at timestamptz);
      insert into purchases values ('${id(3)}','${id(2)}','${id(4)}','draft','PO-test',null,null);
      insert into drugs(id,organization_id,branch_id,quantity) values ('${id(5)}','${id(2)}','${id(4)}',10);
      insert into purchase_items(id,purchase_id,drug_id,drug_name,quantity) values ('${id(6)}','${id(3)}','${id(5)}','Linked',5), ('${id(7)}','${id(3)}',null,'Unlinked',500);
    `)
    const sql = readFileSync('supabase/migrations/20260930090000_require_purchase_stock_posting.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    const complete = () => db.query('select complete_purchase($1) result', [id(3)])
    await expect(complete()).rejects.toThrow('not linked to inventory')
    expect((await db.query('select quantity from drugs')).rows[0].quantity).toBe('10')
    expect((await db.query('select * from stock_movements')).rows).toHaveLength(0)
    expect((await db.query('select status from purchases')).rows[0].status).toBe('draft')
    await db.query('update purchase_items set drug_id=$1 where id=$2', [id(5), id(7)])
    await db.query('update drugs set organization_id=$1', [id(99)])
    await expect(complete()).rejects.toThrow('not available in this facility and branch')
    await db.query('update drugs set organization_id=$1, branch_id=$2', [id(2), id(99)])
    await expect(complete()).rejects.toThrow('not available in this facility and branch')
    await db.query('update drugs set branch_id=$1', [id(4)])
    expect((await complete()).rows[0].result).toEqual({ success: true, items_updated: 2 })
    expect((await db.query('select quantity from drugs')).rows[0].quantity).toBe('515.00')
    expect((await db.query('select * from stock_movements')).rows).toHaveLength(2)
    expect((await db.query('select sum(received_quantity) total from purchase_items')).rows[0].total).toBe('505')
    expect((await complete()).rows[0].result.error).toContain('Only draft purchases')
    // Forward migration resolves unlinked lines by brand before generic name.
    await db.exec("alter table drugs add column name text, add column status text default 'active'")
    const brandMigration = readFileSync('supabase/migrations/20260930100000_purchase_brand_first_matching.sql', 'utf8')
    await db.exec(brandMigration)
    await db.exec(brandMigration)
    await db.exec("delete from stock_movements; delete from purchase_items; update purchases set status='draft'; update drugs set name='Paracetamol', brand_name='Generic', quantity=0")
    await db.query("insert into drugs(id,organization_id,branch_id,quantity,name,brand_name) values ($1,$2,$3,0,'Panadol Plain','Panadol')", [id(8), id(2), id(4)])
    await db.query("insert into purchase_items(id,purchase_id,drug_name,brand_name,quantity) values ($1,$2,'Paracetamol','  PANADOL  ',500)", [id(9), id(3)])
    expect((await complete()).rows[0].result.success).toBe(true)
    expect((await db.query('select drug_id from purchase_items')).rows[0].drug_id).toBe(id(8))
    expect((await db.query('select quantity from drugs where id=$1', [id(5)])).rows[0].quantity).toBe('0')
    await db.exec("delete from stock_movements; update purchases set status='draft'; update purchase_items set drug_id=null; update drugs set quantity=0")
    await db.query("insert into drugs(id,organization_id,branch_id,quantity,name,brand_name) values ($1,$2,$3,0,'Panadol Extra','Panadol')", [id(10), id(2), id(4)])
    await expect(complete()).rejects.toThrow('found 2 exact inventory matches')
    expect((await db.query('select drug_id from purchase_items')).rows[0].drug_id).toBeNull()
    await db.query('update drugs set branch_id=$1 where id=$2', [id(99), id(10)])
    await db.query('update drugs set organization_id=$1 where id=$2', [id(99), id(8)])
    await expect(complete()).rejects.toThrow('found 0 exact inventory matches')
    await db.query('update drugs set organization_id=$1, status=$2 where id=$3', [id(2), 'inactive', id(8)])
    await expect(complete()).rejects.toThrow('found 0 exact inventory matches')
    // With no brand, a unique exact item name can be used.
    await db.exec("update purchase_items set brand_name=null")
    expect((await complete()).rows[0].result.success).toBe(true)
    expect((await db.query('select drug_id from purchase_items')).rows[0].drug_id).toBe(id(5))
    expect((await db.query('select * from stock_movements')).rows).toHaveLength(1)
    expect((await db.query('select sum(received_quantity) total from purchase_items')).rows[0].total).toBe('500')
    expect((await complete()).rows[0].result.error).toContain('Only draft purchases')
    expect((await db.query('select quantity from drugs where id=$1', [id(5)])).rows[0].quantity).toBe('500.00')
    // A mixed invoice posts medicine and consumable lines independently without changing types.
    await db.exec("delete from stock_movements; delete from purchase_items; delete from drugs; update purchases set status='draft'; alter table drugs add column category text")
    await db.query("insert into drugs(id,organization_id,branch_id,name,quantity,category,expiry_date) values ($1,$3,$4,'Panadol',10,'medicine','2028-12-31'),($2,$3,$4,'Examination gloves',20,'consumable',null)", [id(5), id(8), id(2), id(4)])
    await db.query("insert into purchase_items(id,purchase_id,drug_id,drug_name,quantity,unit_cost) values ($1,$3,$4,'Panadol',5,2),($2,$3,$5,'Examination gloves',30,1)", [id(6), id(7), id(3), id(5), id(8)])
    expect((await complete()).rows[0].result).toEqual({ success: true, items_updated: 2 })
    expect((await db.query('select name,quantity,category,expiry_date from drugs order by name')).rows).toEqual([
      { name: 'Examination gloves', quantity: '50.00', category: 'consumable', expiry_date: null },
      { name: 'Panadol', quantity: '15.00', category: 'medicine', expiry_date: new Date('2028-12-31T00:00:00.000Z') },
    ])
    expect((await db.query('select count(*)::int count from stock_movements where reference_id=$1', [id(3)])).rows[0].count).toBe(2)
    expect((await db.query('select sum(received_quantity) total from purchase_items')).rows[0].total).toBe('35')
    expect((await complete()).rows[0].result.error).toContain('Only draft purchases')
  } finally { await db.close() }
}, 60000)
