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
 await db.exec(readFileSync('supabase/migrations/20261004130000_clarify_historical_receipt_conflicts.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/20261004140000_onboarding_fees.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/20261004150000_previous_subscription_arrears.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/20261010120000_billing_invoice_corrections.sql','utf8'))
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
 await expect(history({ ...payload, reference: 'ANOTHER-RECEIPT' })).rejects.toThrow('already marked paid')
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

it('keeps onboarding separate from monthly invoices and subscription coverage', async () => {
 await actor(owner)
 const month=new Date().toISOString().slice(0,7)+'-01'
 const fee={organization_id:org,amount:900,due_on:month}
 const invoke=data=>db.query('select platform_billing_onboarding($1::jsonb)',[JSON.stringify(data)])
 const before=(await db.query('select subscription_ends_at from organizations where id=$1',[org])).rows[0].subscription_ends_at
 await invoke(fee)
 await expect(invoke(fee)).rejects.toThrow('already has an onboarding fee')
 const all=await call('list');const invoice=all.invoices.find(i=>i.kind==='onboarding')
 const result=await call('submit',{invoice_id:invoice.id,reference:'ONBOARD-TEST'})
 await call('review',{payment_id:result.payments.find(p=>p.transaction_reference==='ONBOARD-TEST').id,decision:'approved'})
 expect((await db.query('select subscription_ends_at from organizations where id=$1',[org])).rows[0].subscription_ends_at).toEqual(before)
 await actor(admin)
 await expect(invoke({...fee,organization_id:other})).rejects.toThrow('Platform administrator')
})
it('records already-paid onboarding without duplicating monthly history', async () => {
 await actor(owner)
 const data={organization_id:other,amount:1500,due_on:'2020-01-01',received_on:'2020-01-03',reference:'OLD-ONBOARDING',note:'Receipt checked'}
 await db.query('select platform_billing_onboarding($1::jsonb)',[JSON.stringify(data)])
 await history({organization_id:other,first_month:'2020-01-01',months:1,monthly_amount:100,received_on:'2020-01-03',reference:'OLD-SUBSCRIPTION',note:'Receipt checked'})
 const rows=(await db.query("select kind,paid_at from platform_subscription_invoices where organization_id=$1 and period='2020-01-01'",[other])).rows
 expect(rows).toHaveLength(2)
 expect(rows.every(i=>i.paid_at)).toBe(true)
})

it('adds arrears without recording income and rejects duplicate batches atomically', async()=>{
 await actor(owner)
 const payload={organization_id:org,first_month:'2021-02-01',months:2,monthly_amount:200,due_on:'2021-03-05',note:'Verified unpaid months'}
 const arrears=p=>db.query('select platform_billing_arrears($1::jsonb)',[JSON.stringify(p)])
 const countBefore=(await db.query('select count(*) as n from platform_subscription_payments')).rows[0].n
 await arrears(payload)
 const invoices=(await db.query("select * from platform_subscription_invoices where organization_id=$1 and period between '2021-02-01' and '2021-03-01'",[org])).rows
 expect(invoices).toHaveLength(2);expect(invoices.every(i=>!i.paid_at && Number(i.amount)===200)).toBe(true)
 expect((await db.query('select count(*) as n from platform_subscription_payments')).rows[0].n).toBe(countBefore)
 await expect(arrears({...payload,first_month:'2021-01-01'})).rejects.toThrow('already exists')
 expect((await db.query("select id from platform_subscription_invoices where organization_id=$1 and period='2021-01-01'",[org])).rows).toHaveLength(0)
 await expect(arrears({...payload,first_month:new Date().toISOString().slice(0,7)+'-01'})).rejects.toThrow('before the current month')
 await expect(arrears({...payload,organization_id:other,first_month:'2020-01-01',months:1})).rejects.toThrow('already exists')
 await db.query("update users set role='admin' where id=$1",[admin]);await actor(admin)
 expect((await call('list')).invoices.filter(i=>i.period==='2021-02-01')).toHaveLength(1)
 await expect(arrears(payload)).rejects.toThrow('Platform administrator')
})

it('records an existing onboarding cheque once and audits paid amount corrections', async () => {
 await actor(owner)
 const facility='00000000-0000-0000-0000-000000000099'
 await db.query('insert into organizations(id,name) values($1,$2)',[facility,'Billing correction fixture'])
 const invoice=(await db.query("insert into platform_subscription_invoices(organization_id,period,due_on,amount,kind) values($1,'2020-01-01','2020-01-01',3000,'onboarding') returning id",[facility])).rows[0].id
 const receive = payload => db.query('select platform_billing_receive_invoice($1::jsonb)',[JSON.stringify(payload)])
 const correct = payload => db.query('select platform_billing_correct_invoice($1::jsonb)',[JSON.stringify(payload)])
 const receipt={invoice_id:invoice,expected_amount:3000,received_on:'2020-01-06',reference:'CHEQUE-TEST-832647',note:'Verified cheque payment'}
 await actor(admin)
 await expect(receive(receipt)).rejects.toThrow('Platform administrator')
 await expect(correct({invoice_id:invoice,expected_amount:3000,amount:200,note:'Correction'})).rejects.toThrow('Platform administrator')
 await actor(owner)
 await receive(receipt)
 await expect(receive(receipt)).rejects.toThrow('already paid')
 const paid=(await db.query('select * from platform_subscription_payments where invoice_id=$1',[invoice])).rows[0]
 expect(paid.status).toBe('approved')
 expect(new Date(paid.received_on).toISOString().slice(0,10)).toBe('2020-01-06')
 expect((await db.query('select subscription_ends_at from organizations where id=$1',[facility])).rows[0].subscription_ends_at).toBeNull()
 await correct({invoice_id:invoice,expected_amount:3000,amount:200,note:'Verified corrected receipt amount'})
 const revised=(await db.query('select * from platform_subscription_payments where invoice_id=$1',[invoice])).rows[0]
 expect(Number(revised.amount)).toBe(200)
 expect(revised.received_on).toEqual(paid.received_on)
 expect(revised.transaction_reference).toBe(paid.transaction_reference)
 await expect(correct({invoice_id:invoice,expected_amount:3000,amount:100,note:'Stale correction'})).rejects.toThrow('Invoice changed')
 const audit=(await db.query("select details from platform_billing_audit where organization_id=$1 and action='correct_invoice_amount'",[facility])).rows[0].details
 expect(audit.old_amount).toBe(3000)
 expect(audit.new_amount).toBe(200)
})
