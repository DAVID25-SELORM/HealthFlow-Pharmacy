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
    expect((await db.query('select quantity from drugs')).rows[0].quantity).toBe('515.00')
  } finally { await db.close() }
}, 30000)
