// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, it, expect } from 'vitest'
let db
const owner='00000000-0000-0000-0000-000000000001'
const admin='00000000-0000-0000-0000-000000000002'
const org='00000000-0000-0000-0000-000000000003'
const other='00000000-0000-0000-0000-000000000004'
const call=async(action,data={})=>(await db.query('select platform_billing($1,$2::jsonb) as result',[action,JSON.stringify(data)])).rows[0].result
const actor=id=>db.query("select set_config('test.actor',$1,false)",[id])
beforeAll(async()=>{
 db=new PGlite()
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create function auth.uid() returns uuid language sql as $$ select current_setting('test.actor')::uuid $$;
 create table users(id uuid primary key,organization_id uuid,role text,is_active boolean,assigned_roles text[]);
 create table organizations(id uuid primary key,name text,last_payment_at timestamptz,subscription_ends_at timestamptz,subscription_updated_by uuid);
 insert into organizations(id,name) values('${org}','Facility A'),('${other}','Facility B');
 insert into users values('${owner}',null,'super_admin',true,'{}'),('${admin}','${org}','admin',true,'{}');`)
 await db.exec(readFileSync('supabase/migrations/20261003180000_manual_subscription_billing.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/20261004120000_historical_subscription_receipts.sql','utf8'))
},30000)
afterAll(async()=>db?.close())
const history = payload => db.query('select platform_billing_record_history($1::jsonb)', [JSON.stringify(payload)])
it('records a verified multi-month receipt atomically without inventing arrears', async () => {
 await actor(owner)
 const payload = { organization_id: org, first_month: '2020-01-01', months: 3, monthly_amount: 100, received_on: '2020-01-05', reference: 'OLD-RECEIPT-1', note: 'Matched receipt' }
 await history(payload)
 const rows = (await db.query("select * from platform_subscription_invoices where period < '2021-01-01'")).rows
 expect(rows).toHaveLength(3)
 expect(rows.every(row => row.paid_at)).toBe(true)
 await expect(history({ ...payload, first_month: '2020-04-01' })).rejects.toThrow()
 expect((await db.query("select * from platform_subscription_invoices where period='2020-04-01'")).rows).toHaveLength(0)
 await actor(admin)
 await expect(history({ ...payload, reference: 'OTHER-RECEIPT' })).rejects.toThrow('Platform administrator')
 // Keep existing workflow fixtures independent of this historical receipt.
 await db.exec("delete from platform_subscription_payments; delete from platform_subscription_invoices;")
})
it('generates one invoice, preserves original rate and isolates facility access',async()=>{
 await actor(owner)
 const month=new Date().toISOString().slice(0,7)+'-01'
 await call('set_plan',{organization_id:org,amount:300,starts_on:month,due_day:5})
 await call('set_plan',{organization_id:other,amount:500,starts_on:month,due_day:5})
 await call('set_plan',{organization_id:org,amount:400,starts_on:month,due_day:5})
 await actor(admin)
 const data=await call('list')
 expect(data.invoices).toHaveLength(1)
 expect(Number(data.invoices[0].amount)).toBe(300)
 expect(data.facilities).toHaveLength(1)
 await expect(call('set_plan',{organization_id:org,amount:1,starts_on:month,due_day:5})).rejects.toThrow('Platform administrator')
})
it('keeps submission pending, rejects duplicates and prevents facility self-approval',async()=>{
 await actor(admin)
 const data=await call('list'); const invoice=data.invoices[0]
 const pending=await call('submit',{invoice_id:invoice.id,reference:'MOMO-1234'})
 expect(pending.invoices[0].paid_at).toBeNull()
 expect(pending.payments[0].status).toBe('pending')
 await expect(call('submit',{invoice_id:invoice.id,reference:'MOMO-1234'})).rejects.toThrow()
 await expect(call('review',{payment_id:pending.payments[0].id,decision:'approved'})).rejects.toThrow('Platform administrator')
})
it('approves exactly once and extends subscription only on approval',async()=>{
 await actor(owner)
 const data=await call('list'); const pay=data.payments[0]
 await call('review',{payment_id:pay.id,decision:'approved',note:'Matched MoMo statement'})
 await expect(call('review',{payment_id:pay.id,decision:'approved'})).rejects.toThrow('already reviewed')
 expect((await db.query('select subscription_ends_at from organizations where id=$1',[org])).rows[0].subscription_ends_at).toBeTruthy()
 await actor(admin)
 expect((await call('list')).invoices[0].paid_at).toBeTruthy()
})
it('blocks foreign invoice submission and ordinary staff access',async()=>{
 await actor(owner); const all=await call('list'); const foreign=all.invoices.find(i=>i.organization_id===other)
 await actor(admin)
 await expect(call('submit',{invoice_id:foreign.id,reference:'FOREIGN123'})).rejects.toThrow('unavailable')
 await db.exec(`update users set role='assistant' where id='${admin}'`)
 await expect(call('list')).rejects.toThrow('restricted')
})

it('requires rejection reasons and permits a new transaction after rejection',async()=>{
 await actor(owner)
 const data=await call('list'); const invoice=data.invoices.find(i=>i.organization_id===other)
 const submitted=await call('submit',{invoice_id:invoice.id,reference:'REJECT-123'})
 const pay=submitted.payments.find(p=>p.transaction_reference==='REJECT-123')
 await expect(call('review',{payment_id:pay.id,decision:'rejected'})).rejects.toThrow('rejection reason')
 await call('review',{payment_id:pay.id,decision:'rejected',note:'Transaction not received'})
 const retried=await call('submit',{invoice_id:invoice.id,reference:'RETRY-456'})
 expect(retried.payments.find(p=>p.transaction_reference==='RETRY-456').status).toBe('pending')
 expect((await db.query('select count(*) as n from platform_billing_audit')).rows[0].n).toBeGreaterThan(0)
})
