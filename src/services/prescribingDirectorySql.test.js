// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { beforeAll, afterAll, it, expect } from 'vitest'
let db
const migration = readFileSync('supabase/migrations/20260917190000_shared_prescribing_facility_directory.sql', 'utf8')
const orgA = '00000000-0000-4000-8000-000000000001'
const orgB = '00000000-0000-4000-8000-000000000002'
const userA = '00000000-0000-4000-8000-000000000011'
const userB = '00000000-0000-4000-8000-000000000012'
const admin = '00000000-0000-4000-8000-000000000013'
const login = async id => { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${id}', false); set role authenticated;`) }
const search = async (term, only = false, inactive = false) => (await db.query('select * from search_prescribing_directory($1,$2,$3)', [term,only,inactive])).rows
beforeAll(async () => {
 db = new PGlite()
 await db.exec(`create role anon; create role authenticated; create schema auth;
 create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
 create table branch_sync_clients(id uuid, organization_id uuid, branch_id uuid);
 create table organizations(id uuid primary key); create table branches(id uuid primary key);
 create table users(id uuid primary key, organization_id uuid, role text, is_active boolean, assigned_roles text[]);
 insert into organizations values ('${orgA}'),('${orgB}');
 insert into users values ('${userA}','${orgA}','pharmacist',true,'{}'),('${userB}','${orgB}','pharmacist',true,'{}'),('${admin}',null,'super_admin',true,'{}');
 grant select on users to authenticated;
 create function user_organization_id() returns uuid language sql stable as $$ select organization_id from users where id=auth.uid() $$;
 create table nhis_claims(id uuid primary key default gen_random_uuid(), organization_id uuid, physician_name text, referring_facility text, created_at timestamptz default now());
 alter table nhis_claims enable row level security;
 create policy own_claims on nhis_claims using(organization_id=user_organization_id()) with check(organization_id=user_organization_id());
 grant select,insert,update on nhis_claims to authenticated;
 insert into nhis_claims(organization_id,referring_facility) values ('${orgA}','Historical West Point source');`)
 await db.exec(readFileSync('supabase/migrations/20260721120000_add_nhis_prescriber_facility_records.sql','utf8'))
 await db.exec(`create function get_branch_sync_client(text) returns branch_sync_clients language sql as $$ select null::uuid, '${orgA}'::uuid, null::uuid $$;`)
 await db.exec(readFileSync('supabase/migrations/20260810220000_make_nhis_prescribing_registers_organization_wide.sql','utf8'))
 const before = (await db.query('select * from nhis_claims')).rows
 await db.exec(migration)
 expect((await db.query('select * from nhis_claims')).rows).toEqual(before)
},30000)
afterAll(async () => { await db?.close() })
it('seeds nine names idempotently, without accounts or fabricated eligibility/identifiers',async () => {
 await db.exec(migration)
 const rows = (await db.query('select * from nhis_prescribing_facilities where is_shared')).rows
 expect(rows).toHaveLength(9)
 expect(rows.every(r => r.organization_id === null && r.nhis_enabled === null && r.provider_number === null && r.nhia_facility_code === null)).toBe(true)
 expect((await db.query('select * from organizations')).rows).toHaveLength(2)
})
it('allows name/alias search by either pharmacy, with an explicit NHIS filter',async () => {
 for (const user of [userA,userB]) {
   await login(user)
   expect((await search('Korle'))[0].facility_name).toBe('Korle Bu Teaching Hospital')
   expect((await search('Ridge'))[0].facility_name).toBe('Greater Accra Regional Hospital')
   expect((await search('UGMC'))[0].facility_name).toBe('University of Ghana Medical Centre')
   expect(await search('',true)).toEqual([])
 }
})
it('persists ID and snapshot, leaves manual source unregistered, isolates claims',async () => {
 await login(userA)
 const facility = (await search('Korle'))[0]
 await db.query('insert into nhis_claims(organization_id,prescribing_facility_id,referring_facility) values($1,$2,$3)',[orgA,facility.id,'Untrusted browser label'])
 expect((await db.query('select * from nhis_claims where prescribing_facility_id=$1',[facility.id])).rows[0]).toMatchObject({ prescribing_facility_name_snapshot:'Korle Bu Teaching Hospital',referring_facility:'Korle Bu Teaching Hospital' })
 await db.query('insert into nhis_claims(organization_id,referring_facility,prescribing_facility_name_snapshot) values($1,$2,$2)',[orgA,'Unlisted Clinic'])
 expect((await db.query('select * from nhis_prescribing_facilities')).rows).toHaveLength(9)
 await login(userB)
 expect((await db.query('select * from nhis_claims')).rows).toEqual([])
 await db.query('insert into nhis_claims(organization_id,prescribing_facility_id) values($1,$2)',[orgB,facility.id])
 expect((await db.query('select * from nhis_claims')).rows).toHaveLength(1)
 await login(userA)
 expect((await db.query('select * from nhis_claims where organization_id=$1',[orgB])).rows).toEqual([])
})
it('denies shared edits by pharmacy and definer sync routes; permits platform management',async () => {
 await login(userA)
 expect((await db.query("update nhis_prescribing_facilities set facility_name='Tampered' where is_shared returning id")).rows).toEqual([])
 await expect(db.exec("insert into nhis_prescribing_facilities(facility_name,is_shared) values('Fake',true)")).rejects.toThrow()
 const target = (await search('Korle'))[0]
 await expect(db.query("select branch_sync_upsert_nhis_prescribing_record('test','nhis_prescribing_facilities',$1,'{\"facility_name\":\"Tampered\"}')",[target.id])).rejects.toThrow('Only platform')
 // Definer functions bypass RLS, but the table trigger must still enforce authority.
 await db.exec('reset role')
 await expect(db.exec("update nhis_prescribing_facilities set facility_name='Tampered' where is_shared")).rejects.toThrow('Only platform')
 await login(admin)
 await db.exec("update nhis_prescribing_facilities set nhis_enabled=true, area='Test area' where facility_name='LEKMA Hospital'")
 await login(userA)
 expect((await search('Test area',true))[0].facility_name).toBe('LEKMA Hospital')
})
it('keeps historical references and snapshots through rename/deactivation and rejects new selection',async () => {
 await login(admin)
 const facility = (await search('Korle'))[0]
 await db.query("update nhis_prescribing_facilities set facility_name='Renamed Hospital',status='inactive' where id=$1",[facility.id])
 await login(userA)
 expect(await search('Renamed')).toEqual([])
 expect(await search('Renamed',false,true)).toEqual([])
 const claim = (await db.query('select * from nhis_claims where prescribing_facility_id=$1',[facility.id])).rows[0]
 expect(claim.prescribing_facility_name_snapshot).toBe('Korle Bu Teaching Hospital')
 await db.query('update nhis_claims set prescribing_facility_id=prescribing_facility_id where id=$1',[claim.id])
 await expect(db.query('insert into nhis_claims(organization_id,prescribing_facility_id) values($1,$2)',[orgA,facility.id])).rejects.toThrow('active')
 await login(admin)
 expect(await search('Renamed',false,true)).toHaveLength(1)
 await db.exec('reset role')
 await expect(db.query('delete from nhis_prescribing_facilities where id=$1',[facility.id])).rejects.toThrow('Deactivate')
 await db.exec(migration)
 expect((await db.query('select * from nhis_prescribing_facilities where is_shared')).rows).toHaveLength(9)
 expect((await db.query('select status from nhis_prescribing_facilities where id=$1',[facility.id])).rows[0].status).toBe('inactive')
})
it('rejects another pharmacy private facility reference',async () => {
 await db.exec('reset role')
 const row = (await db.query("insert into nhis_prescribing_facilities(organization_id,facility_name) values($1,'Private source') returning id",[orgB])).rows[0]
 await login(userA)
 expect((await db.query('select * from nhis_prescribing_facilities where id=$1',[row.id])).rows).toEqual([])
 await expect(db.query('insert into nhis_claims(organization_id,prescribing_facility_id) values($1,$2)',[orgA,row.id])).rejects.toThrow('does not belong')
})
