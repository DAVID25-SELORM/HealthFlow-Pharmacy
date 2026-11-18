// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { it, expect } from 'vitest'
import { nehfamsAdapter } from '../../supabase/functions/_shared/nehfamsAdapter.ts'
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
it('blocks every NeHFAMS operation without a transport', async () => {
 for (const operation of ['authenticate','manageAccessToken','verifyMember','generateAttendance','retrieveAttendance','validateRequest','validateResponse','validateFacility','classifyError']) {
  await expect(nehfamsAdapter.execute(operation, { organizationId: id(1), branchId: null, credentialVersion: 1 }, {})).rejects.toThrow(/not available/)
 }
})
it('enforces SQL isolation, duplicate reservation, disabled provider and durable claim linkage', async () => {
 const db = new PGlite()
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table organizations(id uuid primary key);
 create table branches(id uuid primary key, organization_id uuid);
 create table users(id uuid primary key, organization_id uuid, branch_id uuid, role text, is_active boolean);
 create table nhis_claims(id uuid primary key, organization_id uuid, branch_id uuid, member_no text, card_type text, nhia_attendance_date date, ccc_no text);
 create type branch_client as (organization_id uuid,branch_id uuid);
 create function get_branch_sync_client(text) returns branch_client language sql as 'select null::uuid,null::uuid';
 insert into organizations values ('${id(1)}'),('${id(2)}');
 insert into branches values ('${id(5)}','${id(1)}'),('${id(6)}','${id(2)}');
 insert into users values ('${id(3)}','${id(1)}',null,'admin',true),('${id(4)}','${id(1)}',null,'super_admin',true);
 insert into nhis_claims values ('${id(20)}','${id(1)}',null,'old',null,'2020-01-01','11111');`)
 for (const name of ['20261010090000_organization_ccc_providers','20261017100000_prepare_nehfams_provider','20261017101000_link_claim_ccc_attendance']) await db.exec(readFileSync(`supabase/migrations/${name}.sql`,'utf8'))
 const reserve = (org=id(1),branch=id(5)) => db.query(`select reserve_ccc_attendance($1,$2,$3,'unsaved-draft','12345678','NHISCARD',(now() at time zone 'Africa/Accra')::date) as r`,[org,id(3),branch])
 await expect(reserve(id(2))).rejects.toThrow(/membership/)
 await expect(reserve(id(1),id(6))).rejects.toThrow(/branch/)
 // PGlite serializes queued calls; this verifies duplicate outcomes, not multi-session lock scheduling.
 const concurrent=await Promise.allSettled([reserve(),reserve()])
 expect(concurrent.filter(x=>x.status==='fulfilled')).toHaveLength(1)
 expect(concurrent.filter(x=>x.status==='rejected')).toHaveLength(1)
 const request=concurrent.find(x=>x.status==='fulfilled').value.rows[0].r.request_id
 const save=(provider,enabled,actor=id(4))=>db.query(`select save_ccc_policy($1,$2,$3,$4,null,null,'new','new')`,[id(1),actor,provider,enabled])
 await expect(save('nehfams',false)).rejects.toThrow(/unresolved/)
 await db.query(`update ccc_attendance_requests set status='unknown' where id=$1`,[request])
 await expect(reserve()).rejects.toThrow(/unresolved/)
 await db.query(`update ccc_attendance_requests set status='succeeded',result='{"ccCode":"12345"}' where id=$1`,[request])
 expect((await reserve()).rows[0].r.cached).toBe(true)
 await db.query(`insert into nhis_claims(id,organization_id,branch_id,member_no,card_type,nhia_attendance_date,ccc_no) values ($1,$2,$3,'12345678','NHISCARD',(now() at time zone 'Africa/Accra')::date,'12345')`,[id(21),id(1),id(5)])
 expect((await db.query('select ccc_attendance_request_id as link from nhis_claims where id=$1',[id(21)])).rows[0].link).toBe(request)
 await expect(db.query('update nhis_claims set organization_id=$1 where id=$2',[id(2),id(21)])).rejects.toThrow(/does not match/)
 await expect(db.query('update nhis_claims set ccc_no=$1 where id=$2',['99999',id(21)])).rejects.toThrow(/does not match/)
 expect((await db.query('select ccc_attendance_request_id as link from nhis_claims where id=$1',[id(20)])).rows[0].link).toBeNull()
 await expect(save('nehfams',false,id(3))).rejects.toThrow(/administrator/)
 await expect(save('nehfams',true)).rejects.toThrow(/unavailable/)
 await db.exec("update organization_ccc_policy set token_encrypted='ciphertext',expected_hpn='original',expected_facility_name='Original Facility'")
 await save('nehfams',false)
 await expect(reserve()).rejects.toThrow(/not available/)
 const policy=(await db.query('select * from organization_ccc_policy')).rows[0]
 expect(policy).toMatchObject({provider:'nehfams',enabled:false,token_encrypted:'ciphertext',expected_hpn:'original',expected_facility_name:'Original Facility'})
 await expect(db.exec('update organization_ccc_policy set enabled=true')).rejects.toThrow(/nehfams_live_disabled/)
 await save('existing',true)
 expect((await reserve()).rows[0].r.cached).toBe(true)
 const permissions=(await db.query("select has_table_privilege('authenticated','organization_nehfams_configuration','SELECT') as allowed")).rows[0]
 expect(permissions.allowed).toBe(false)
 } finally { await db.close() }
},30000)
