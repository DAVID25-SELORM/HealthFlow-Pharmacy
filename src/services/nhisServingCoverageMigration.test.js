// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest'

let db
const org = '00000000-0000-0000-0000-000000000001'
const prior = '00000000-0000-0000-0000-000000000002'
const current = '00000000-0000-0000-0000-000000000003'
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${org}'::uuid $$;
    create function user_organization_id() returns uuid language sql as $$ select coalesce(nullif(current_setting('test.facility',true),''),'${org}')::uuid $$;
    create table nhis_claims (id uuid primary key, organization_id uuid, member_no text, hin text,
      claim_number text, service_date_from date, created_at timestamptz default now(), status text);
    create table nhis_drugs (id uuid, organization_id uuid, code text, generic_name text,
      strength text, dosage_form text, description text);
    create table nhis_claim_medicines (id serial primary key, claim_id uuid, nhis_drug_id uuid,
      drug_code text, description text, dispensary_date date, prescribed_qty numeric, dispensed_qty numeric,
      served_qty numeric, serving_status text, dose text, frequency text, duration text);
    create table organizations (id uuid primary key, name text);
    create table users (id uuid, organization_id uuid, role text, assigned_roles text[]);
    insert into users values ('${org}', '${org}', 'claims_officer', '{}');
    alter table nhis_claims add column direct_served_at timestamptz, add column direct_served_by uuid,
      add column ccc_no text default '12345', add column serving_status text,
      add column serving_reviewed_by uuid, add column serving_reviewed_at timestamptz,
      add column total_amount numeric, add column updated_at timestamptz;
    alter table nhis_claim_medicines add column served_at timestamptz,
      add column unit_price numeric default 1, add column total_amount numeric;
    alter table users add column is_active boolean default true, add column can_manage_claims boolean default false;
    alter table nhis_claim_medicines add column unit text, add column medicine_access_level text,
      add column required_pharmacy_level text, add column reason_if_not_fully_served text,
      add column entered_by_claims_officer uuid, add column served_by_mca uuid, add column entered_at timestamptz;
    create function assert_nhis_ccc_for_progress(text) returns void language sql as $$ select $$;
  `)
  const directServing = readFileSync('supabase/migrations/20260912170000_enforce_nhis_ccc_transitions.sql', 'utf8')
  await db.exec(directServing.slice(directServing.indexOf('create or replace function public.serve_nhis_claim_medicines'), directServing.indexOf("notify pgrst")))
  await db.exec(readFileSync('supabase/migrations/20260801100000_fix_nhis_active_medication_future_dispensing_window.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20260801120000_add_nhis_patient_active_medication_summary.sql', 'utf8'))
  // Execute the real date/tenant patch; the remainder defines unrelated branch sync RPCs.
  const datePatch = readFileSync('supabase/migrations/20260820100000_fix_cross_facility_medicine_dispensing_dates.sql', 'utf8')
  await db.exec(datePatch.slice(0, datePatch.indexOf('-- Keep the broad legacy sync core unchanged.')))
  await db.exec(readFileSync('supabase/migrations/20260823100000_expose_active_medication_serving_facility.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261002110000_check_coverage_before_nhis_serving.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261003120000_require_identity_for_nhis_coverage.sql', 'utf8'))
  // Verify the correction against the actual exported production body too.
  await db.exec(readFileSync('src/services/fixtures/nhis-overlap-production-20261003.sql', 'utf8'))
  const membershipPatch = readFileSync('supabase/migrations/20261003130000_fix_nhis_overlap_caller_membership.sql', 'utf8')
  await db.exec(membershipPatch)
  await db.exec(membershipPatch) // Rerunning must preserve the function.
  await db.exec(readFileSync('supabase/migrations/20261003140000_align_nhis_serving_coverage_dates.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261003150000_recheck_nhis_coverage_on_claim_edit.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261003160000_lock_all_nhis_coverage_identifiers.sql', 'utf8'))
  await db.exec('drop trigger guard_nhis_coverage_claim_edit on nhis_claims')
  await db.exec(readFileSync('supabase/migrations/20261003170000_complete_nhis_coverage_guards.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261006223000_fix_nhis_coverage_dose_units_and_facility.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261008233000_fix_ambiguous_injection_coverage.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261008233000_fix_ambiguous_injection_coverage.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261009001000_match_heparin_pack_coverage.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261009001000_match_heparin_pack_coverage.sql', 'utf8'))
}, 60000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec(`select set_config('test.facility','${org}',false); update users set organization_id='${org}'; truncate nhis_claim_medicines, nhis_claims, nhis_drugs, organizations;
    insert into organizations select ('00000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid, 'Test facility ' || n from generate_series(1,12) n;
    insert into nhis_claims(id, organization_id, member_no, service_date_from, status) values
      ('${prior}', '${org}', '12345678', '2026-09-07', 'served'),
      ('${current}', '${org}', '12345678', '2026-09-14', 'draft');
    insert into nhis_claim_medicines(claim_id, drug_code, description, prescribed_qty, dispensed_qty,
      served_qty, serving_status, dose, frequency, duration) values
      ('${prior}', 'DRUG-A', 'Medicine A tablet', 28, 28, 28, 'fully_served', '1', 'BD', '14 days'),
      ('${current}', 'DRUG-A', 'Medicine A tablet', 28, 0, 0, 'pending', '1', 'BD', '14 days');`)
})
const serve = () => db.exec(`update nhis_claim_medicines set served_qty = 28,
  dispensed_qty = 28, serving_status = 'fully_served' where claim_id = '${current}'`)

it('blocks the reported 7th/14th overlap before serving and preserves pending quantities', async () => {
  await expect(serve()).rejects.toThrow('coverage through 2026-09-20 (7 day(s) remaining)')
  const { rows } = await db.query(`select served_qty, serving_status from nhis_claim_medicines where claim_id = '${current}'`)
  expect(rows[0]).toMatchObject({ served_qty: '0', serving_status: 'pending' })
})
it('allows the next supply after coverage ends', async () => {
  await db.exec(`update nhis_claims set service_date_from = '2026-09-21' where id = '${current}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('does not match another member', async () => {
  await db.exec(`update nhis_claims set member_no = '87654321' where id = '${current}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('allows a different medicine', async () => {
  await db.exec(`update nhis_claim_medicines set drug_code = 'DRUG-B' where claim_id = '${current}'`)
  await expect(serve()).resolves.toBeDefined()
})
it('checks equivalent ingredients when medicine codes differ', async () => {
  await db.exec(`insert into nhis_drugs values
    ('${prior}', '${org}', 'DRUG-A', 'ingredient', '10mg', 'tablet', 'Medicine A'),
    ('${current}', '${org}', 'DRUG-B', 'ingredient', '10mg', 'tablet', 'Medicine B');
    update nhis_claim_medicines set drug_code = 'DRUG-B' where claim_id = '${current}'`)
  await expect(serve()).rejects.toThrow('Cannot serve')
})
it('blocks the real Serve Directly RPC and leaves the claim unserved', async () => {
  await db.exec(`update nhis_claim_medicines m set dispensary_date=c.service_date_from from nhis_claims c where m.claim_id=c.id and c.id='${current}'`)
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('Cannot serve')
  const { rows } = await db.query('select status, direct_served_at from nhis_claims where id = $1', [current])
  expect(rows[0]).toEqual({ status: 'draft', direct_served_at: null })
})
it('allows the real Serve Directly RPC after coverage ends', async () => {
  await db.exec(`update nhis_claims set service_date_from = '2026-09-21' where id = '${current}'`)
  const { rows } = await db.query('select serve_nhis_claim_direct($1) as result', [current])
  expect(rows[0].result).toMatchObject({ status: 'served', total_amount: 28 })
})
it('retains coverage for supplied medicines on cancelled claims', async () => {
  await db.exec(`update nhis_claims set status = 'cancelled' where id = '${prior}'`)
  await expect(serve()).rejects.toThrow('Cannot serve')
})
it('checks a served medicine inserted by the dispensary replacement path', async () => {
  await expect(db.exec(`insert into nhis_claim_medicines(claim_id, drug_code, served_qty, serving_status)
    values ('${current}', 'DRUG-A', 28, 'fully_served')`)).rejects.toThrow('Cannot serve')
})
it('does not block pending entry or unrelated metadata corrections', async () => {
  await expect(db.exec(`update nhis_claim_medicines set description = 'Corrected description'`)).resolves.toBeDefined()
})
it('rolls back all lines if one of several medicines overlaps', async () => {
  await db.exec(`insert into nhis_claim_medicines(claim_id, drug_code, served_qty, serving_status)
    values ('${current}', 'DRUG-B', 0, 'pending')`)
  await expect(serve()).rejects.toThrow('Cannot serve')
  const { rows } = await db.query(`select sum(served_qty) as total from nhis_claim_medicines where claim_id = '${current}'`)
  expect(rows[0].total).toBe('0')
})
it('rejects serving outside the authenticated facility', async () => {
  await db.exec(`update nhis_claims set organization_id = '${prior}' where id = '${current}'`)
  await expect(serve()).rejects.toThrow('outside your organization')
})
it('does not silently serve when the coverage check is unavailable', async () => {
  await db.exec(`begin; alter function check_nhis_active_medication_overlap(
    text, text, text, date, uuid, uuid, text, text, text, numeric, text, text, text
  ) rename to unavailable_coverage_check`)
  try {
    await expect(serve()).rejects.toThrow('does not exist')
  } finally {
    await db.exec('rollback')
  }
})

it.each(['00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012'])(
  'enforces both actual serving RPCs for facility %s without a facility opt-in', async (facility) => {
    await db.query("select set_config('test.facility',$1,false)", [facility])
    await db.query('update users set organization_id=$1', [facility])
    await db.query('update nhis_claims set organization_id=$1', [facility])
    await db.exec(`update nhis_claim_medicines m set dispensary_date=c.service_date_from from nhis_claims c where m.claim_id=c.id and c.id='${current}'`)
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('Cannot serve')
    await expect(db.query('select serve_nhis_claim_medicines($1,$2::jsonb,28)', [current, JSON.stringify([
      {dispensary_date:'2026-09-14',drug_code:'DRUG-A', description:'Medicine A', served_qty:28, serving_status:'fully_served', duration:'14 days'}
    ])])).rejects.toThrow('Cannot serve')
    expect((await db.query('select served_qty from nhis_claim_medicines where claim_id=$1',[current])).rows[0].served_qty).toBe('0')
  })
it('blocks a repeat supply recorded at another facility without exposing its claim reference', async () => {
  await db.query('update nhis_claims set organization_id=$1 where id=$2', [current, prior])
  await db.exec(`update nhis_claim_medicines m set dispensary_date=c.service_date_from from nhis_claims c where m.claim_id=c.id and c.id='${current}'`)
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('Cannot serve')
})
it('blocks five days of paracetamol supplied again on day two', async () => {
  await db.exec(`update nhis_claims set service_date_from='2026-09-08' where id='${current}';
    update nhis_claim_medicines set drug_code='PARACETAMOL', description='Paracetamol tablets',
      prescribed_qty=15, served_qty=15, dispensed_qty=15, dose='1',frequency='TDS',duration='5 days' where claim_id='${prior}';
    update nhis_claim_medicines set drug_code='PARACETAMOL' where claim_id='${current}'`)
  await db.exec(`update nhis_claim_medicines m set dispensary_date=c.service_date_from from nhis_claims c where m.claim_id=c.id and c.id='${current}'`)
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('coverage through 2026-09-11')
})


it('uses the previous actual serving date when the claim date is older', async () => {
  await db.exec(`update nhis_claims set service_date_from='2026-08-01' where id='${prior}';
    update nhis_claim_medicines set served_at='2026-09-07T12:00:00Z' where claim_id='${prior}'`)
  await expect(serve()).rejects.toThrow('coverage through 2026-09-20')
})
it('blocks coverage checks for inactive facility membership', async () => {
  await db.exec('update users set is_active=false')
  try {
    await expect(serve()).rejects.toThrow('Active organization membership is required')
  } finally {
    await db.exec('update users set is_active=true')
  }
})
it('fails closed when an existing supply has no clinical date', async () => {
  await db.exec(`update nhis_claims set service_date_from=null where id='${prior}'`)
  await expect(serve()).rejects.toThrow('Cannot serve')
})

it('rejects serving when both patient identifiers are missing or punctuation only', async () => {
  await db.exec(`update nhis_claims set member_no=' -- ', hin=null where id='${current}'`)
  await expect(serve()).rejects.toThrow('member number or HIN is required')
})
it('rejects serving when the medicine code is missing', async () => {
  await db.exec(`update nhis_claim_medicines set drug_code=' ' where claim_id='${current}'`)
  await expect(serve()).rejects.toThrow('medicine code is required')
})

const lookupCoverage = (claimedOrg = org) => db.query(`select * from check_nhis_active_medication_overlap(
  p_member_no => '12345678', p_medicine_code => 'DRUG-A', p_service_date => '2026-09-14',
  p_current_claim_id => $1, p_current_organization_id => $2)`, [current, claimedOrg])

it('derives the own-facility label and reference from the signed-in membership', async () => {
  const { rows } = await lookupCoverage(prior)
  expect(rows[0]).toMatchObject({source_label:'Test facility 1', previous_claim_reference:prior})
})
it('keeps another facility claim reference private despite a spoofed organization parameter', async () => {
  await db.query('update nhis_claims set organization_id=$1 where id=$2', [current, prior])
  const { rows } = await lookupCoverage(current)
  expect(rows[0]).toMatchObject({source_label:'Test facility 3', previous_claim_reference:null})
})
it('rejects inactive users calling the coverage lookup directly', async () => {
  await db.exec('update users set is_active=false')
  try {
    await expect(lookupCoverage()).rejects.toThrow('Active organization membership is required')
  } finally {
    await db.exec('update users set is_active=true')
  }
})

it('checks the new actual serving date rather than an older claim date', async () => {
  await db.exec(`update nhis_claims set service_date_from='2026-08-01' where id='${current}';
    update nhis_claim_medicines set served_at='2026-09-14T12:00:00Z' where claim_id='${current}'`)
  await expect(serve()).rejects.toThrow('coverage through 2026-09-20')
})
it('rechecks a served-at correction even when quantity and status stay unchanged', async () => {
  await db.exec(`update nhis_claims set service_date_from='2026-09-21' where id='${current}'`)
  await serve()
  await expect(db.exec(`update nhis_claim_medicines set served_at='2026-09-14T12:00:00Z'
    where claim_id='${current}'`)).rejects.toThrow('Cannot serve')
})

async function withClaimEditGuard(check) {
  await db.exec(readFileSync('supabase/migrations/20261003150000_recheck_nhis_coverage_on_claim_edit.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/20261003160000_lock_all_nhis_coverage_identifiers.sql', 'utf8'))
  try { await check() } finally {
    await db.exec('drop trigger guard_nhis_coverage_claim_edit on nhis_claims')
  }
}
it('rolls back an identity edit that creates a served overlap', async () => {
  await db.exec(`update nhis_claims set member_no='OTHER' where id='${current}'`)
  await serve()
  await withClaimEditGuard(async () => {
    await expect(db.exec(`update nhis_claims set member_no='12345678' where id='${current}'`)).rejects.toThrow('Cannot change this served claim')
    expect((await db.query('select member_no from nhis_claims where id=$1',[current])).rows[0].member_no).toBe('OTHER')
  })
})
it('rechecks a service-date correction on a served legacy line without a served timestamp', async () => {
  await db.exec(`update nhis_claims set service_date_from='2026-09-21' where id='${current}'`)
  await serve()
  await withClaimEditGuard(async () => {
    await expect(db.exec(`update nhis_claims set service_date_from='2026-09-14' where id='${current}'`)).rejects.toThrow('Cannot change this served claim')
  })
})
it('allows unrelated metadata and unserved identity corrections', async () => {
  await withClaimEditGuard(async () => {
    await expect(db.exec(`update nhis_claims set claim_number='CORRECTED' where id='${prior}';
      update nhis_claims set member_no='CORRECTED' where id='${current}'`)).resolves.toBeDefined()
  })
})
it('rejects removing every identifier from a served claim', async () => {
  await withClaimEditGuard(async () => {
    await expect(db.exec(`update nhis_claims set member_no=null,hin=null where id='${prior}'`)).rejects.toThrow('Cannot remove')
  })
})

it('keeps both coverage guards active during direct and dispensary serving', async () => {
  await db.exec(`update nhis_claim_medicines set dispensary_date='2026-09-14' where claim_id='${current}'`)
  await withClaimEditGuard(async () => {
    await expect(db.query('select serve_nhis_claim_direct($1)',[current])).rejects.toThrow('Cannot serve')
    await expect(db.query('select serve_nhis_claim_medicines($1,$2::jsonb,28)', [current,JSON.stringify([
      {drug_code:'DRUG-A',description:'Medicine A',served_qty:28,serving_status:'fully_served',dispensary_date:'2026-09-14',duration:'14 days'}
    ])])).rejects.toThrow('Cannot serve')
    await db.exec(`update nhis_claims set service_date_from='2026-09-21' where id='${current}';
      update nhis_claim_medicines set dispensary_date='2026-09-21' where claim_id='${current}'`)
    await expect(db.query('select serve_nhis_claim_direct($1)',[current])).resolves.toBeDefined()
    expect((await db.query('select status from nhis_claims where id=$1',[current])).rows[0].status).toBe('served')
  })
})

it.each(['draft','pending_serving','serving_in_progress','rejected','deleted'])(
  'retains supplied coverage after administrative status changes to %s', async (status) => {
    await db.query('update nhis_claims set status=$1 where id=$2',[status,prior])
    await expect(serve()).rejects.toThrow('Cannot serve')
  })
it('blocks duplicate supplied lines through the actual direct RPC atomically', async () => {
  await db.exec(`update nhis_claims set member_no='OTHER' where id='${current}';
    insert into nhis_claim_medicines(claim_id,drug_code,prescribed_qty,served_qty,serving_status)
    values ('${current}',' drug-a ',10,0,'pending')`)
  await expect(db.query('select serve_nhis_claim_direct($1)',[current])).rejects.toThrow('duplicate medicine lines')
  expect((await db.query('select sum(served_qty) as total from nhis_claim_medicines where claim_id=$1',[current])).rows[0].total).toBe('0')
})
it('blocks duplicate supplied lines through the replacement RPC atomically', async () => {
  await db.exec(`update nhis_claims set member_no='OTHER' where id='${current}'`)
  const line={drug_code:'DRUG-A',served_qty:10,serving_status:'fully_served',duration:'5 days'}
  await expect(db.query('select serve_nhis_claim_medicines($1,$2::jsonb,20)',[current,JSON.stringify([line,line])])).rejects.toThrow('duplicate medicine lines')
  expect((await db.query('select count(*) as n from nhis_claim_medicines where claim_id=$1',[current])).rows[0].n).toBe(1)
})
it('allows multiple supplied medicines with different codes in one claim', async () => {
  await db.exec(`update nhis_claims set member_no='OTHER' where id='${current}';
    insert into nhis_claim_medicines(claim_id,drug_code,prescribed_qty,served_qty,serving_status)
    values ('${current}','DRUG-B',10,0,'pending')`)
  await expect(db.query('select serve_nhis_claim_direct($1)',[current])).resolves.toBeDefined()
})

it('converts 200 mg capsule doses to units and reports the actual facility in both alerts', async () => {
  await db.exec(`insert into nhis_drugs values ('${prior}','${org}','DRUG-A','fluconazole','200 mg','capsule','Fluconazole Capsule, 200 mg');
    update nhis_claim_medicines set dose='200 mg' where claim_id='${prior}'`)
  const {rows}=await lookupCoverage()
  expect(rows[0]).toMatchObject({calculated_treatment_days:'14.00',coverage_end_date:new Date('2026-09-20T00:00:00.000Z'),source_label:'Test facility 1'})
  const summary=await db.query(`select * from get_nhis_patient_active_medications('12345678',null,'2026-09-14',$1,$2)`,[current,org])
  expect(summary.rows[0]).toMatchObject({calculated_treatment_days:'14.00',source_label:'Test facility 1'})
})
it.each([
  ['200 mg','200 mg','capsule', '1'],
  ['0.5 g','250 mg','tablet', '2'],
  ['500 mcg','0.5 mg','tablet', '1'],
  ['2 tablets','','tablet', '2'],
  ['200 mg','','capsule', null],
  ['5 ml','250 mg/5 ml','suspension', null],
  ['1 application','5%','cream', null],
  ['1/2 tablet','200 mg','tablet', null],
])('handles coverage dose %s with strength %s safely', async (dose,strength,form,expected) => {
  const {rows}=await db.query("select nhis_coverage_dose_units($1,$2,$3,'') as units",[dose,strength,form])
  if(expected===null) expect(rows[0].units).toBeNull()
  else expect(Number(rows[0].units)).toBe(Number(expected))
})
it('uses documented duration when mass dose cannot be converted from catalog strength', async () => {
  await db.exec(`update nhis_claim_medicines set dose='200 mg' where claim_id='${prior}'`)
  const {rows}=await lookupCoverage()
  expect(rows[0]).toMatchObject({calculated_treatment_days:null,coverage_end_date:new Date('2026-09-20T00:00:00.000Z')})
})

it.each(['5000 IU', '2 mL', '5000', '40'])('blocks a cross-facility repeat injection with dose %s during recorded coverage', async (dose) => {
  await db.exec(`update nhis_claims set service_date_from='2026-09-23' where id='${prior}';
    update nhis_claims set service_date_from='2026-09-25' where id='${current}';
    update nhis_claim_medicines set dispensary_date='2026-09-25' where claim_id='${current}';
    update nhis_claim_medicines set description='Heparin injection';
    insert into nhis_drugs values ('${prior}','${current}','DRUG-A','heparin','5000 IU/mL','injection','Heparin injection');`)
  await db.query('update nhis_claim_medicines set dose=$1 where claim_id=$2', [dose, prior])
  await db.query('update nhis_claims set organization_id=$1 where id=$2', [current, prior])
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('coverage through 2026-10-06')
  expect((await db.query('select served_qty from nhis_claim_medicines where claim_id=$1', [current])).rows[0].served_qty).toBe('0')
  const line = { drug_code: 'DRUG-A', description: 'Heparin injection', dose,
    served_qty: 28, serving_status: 'fully_served', duration: '14 days', dispensary_date: '2026-09-25' }
  await expect(db.query('select serve_nhis_claim_medicines($1,$2::jsonb,28)', [current, JSON.stringify([line])])).rejects.toThrow('coverage through 2026-10-06')
  const summary = await db.query("select * from get_nhis_patient_active_medications('12345678',null,'2026-09-25',$1,$2)", [current, org])
  expect(summary.rows[0].coverage_end_date).toEqual(new Date('2026-10-06T00:00:00.000Z'))
})

it('does not interpret a bare injection dose as dosage units', async () => {
  const { rows } = await db.query("select nhis_coverage_dose_units('5000','5000 IU/mL','injection','Heparin injection') as units")
  expect(rows[0].units).toBeNull()
})

it('runs the read-only investigation without changing medicine records', async () => {
  const before = (await db.query('select * from nhis_claim_medicines order by id')).rows
  await db.exec(readFileSync('docs/diagnostics/nhis-repeat-injection-review.sql', 'utf8'))
  expect((await db.query('select * from nhis_claim_medicines order by id')).rows).toEqual(before)
})

it.each([
  ['5000', '', '', '', null],
  ['40', '', '', 'Furosemide inj', null],
  ['2', '', 'tablet', 'Medicine tablet', 2],
  ['2 tablets', '', '', '', 2],
  ['5', '250 mg/5 ml', 'suspension', '', null],
  ['5000', '5000 IU/mL', '', '', null],
])('interprets ambiguous dose %s only when count units are known', async (dose, strength, form, description, expected) => {
  const { rows } = await db.query('select nhis_coverage_dose_units($1,$2,$3,$4) as units', [dose, strength, form, description])
  expect(rows[0].units === null ? null : Number(rows[0].units)).toBe(expected)
})


it.each([['HEPARIIN3','HEPARIIN2'], ['HEPARIIN2','HEPARIIN3']])('blocks missing-catalogue heparin packs %s to %s across facilities', async (previousCode, nextCode) => {
  await db.query("update nhis_claim_medicines set drug_code=$1, description='Heparin Injection, 5000 units/mL', dose='10000 iu' where claim_id=$2", [previousCode, prior])
  await db.query('update nhis_claims set organization_id=$1 where id=$2', [current, prior])
  await db.query("update nhis_claim_medicines set drug_code=$1, description='Heparin Injection, 5000 units/mL', dispensary_date='2026-09-14' where claim_id=$2", [nextCode, current])
  await expect(db.query('select serve_nhis_claim_direct($1)', [current])).rejects.toThrow('coverage through 2026-09-20')
  const line = {drug_code: nextCode, description: 'Heparin Injection, 5000 units/mL', dose: '5000 iu', duration: '1 day', served_qty: 2, serving_status: 'fully_served', dispensary_date: '2026-09-14'}
  await expect(db.query('select serve_nhis_claim_medicines($1,$2::jsonb,2)', [current,JSON.stringify([line])])).rejects.toThrow('Cannot serve')
  expect((await db.query('select served_qty from nhis_claim_medicines where claim_id=$1',[current])).rows[0].served_qty).toBe('0')
  await db.exec(`update nhis_claims set service_date_from='2026-09-21' where id='${current}'; update nhis_claim_medicines set dispensary_date='2026-09-21' where claim_id='${current}'`)
  await expect(db.query('select serve_nhis_claim_direct($1)',[current])).resolves.toBeDefined()
})

it.each(['HEPARIIN1','FUROSEIN1','HEPARIIN20'])('does not infer the same concentration from code prefixes: %s', async (nextCode) => {
  await db.exec(`update nhis_claim_medicines set drug_code='HEPARIIN3', description='Heparin injection', dose='10000 iu' where claim_id='${prior}'`)
  await db.query('update nhis_claim_medicines set drug_code=$1 where claim_id=$2',[nextCode,current])
  await expect(serve()).resolves.toBeDefined()
})
