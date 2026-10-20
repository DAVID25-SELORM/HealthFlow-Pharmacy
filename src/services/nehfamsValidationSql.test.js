// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { it, expect } from 'vitest'
it('validates test activation, stale versions, reservation and claim linkage', async () => {
 const db = new PGlite()
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table organizations(id uuid primary key);
 create table branches(id uuid primary key, organization_id uuid);
 create table users(id uuid primary key, organization_id uuid, branch_id uuid, role text, is_active boolean);
 create table nhis_claims(id uuid primary key, organization_id uuid, member_no text, branch_id uuid, service_date_from date, ccc_no text);
 create type branch_client as (organization_id uuid,branch_id uuid);
 create function get_branch_sync_client(text) returns branch_client language sql as 'select null::uuid,null::uuid';
 insert into organizations values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
 insert into users values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',null,'admin',true);`)

 await db.exec(readFileSync('supabase/migrations/20261010090000_organization_ccc_providers.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/20261020200000_prepare_nehfams_connection.sql','utf8'))
 await db.exec(readFileSync('supabase/migrations/20261021090000_nehfams_test_validation_and_linkage.sql','utf8'))
 const org='00000000-0000-0000-0000-000000000001', actor='00000000-0000-0000-0000-000000000003'
 await db.exec(`update users set role='super_admin'`)
 const configure=()=>db.query('select configure_nehfams_connection($1,$2,$3,$4,$5,$6,$7)',[org,actor,'test','encrypted-key','encrypted-secret','123','Test Facility'])
 await configure()
 await expect(db.query('select activate_nehfams_test($1,$2)',[org,actor])).rejects.toThrow(/Validate/)
 await expect(db.query('select validate_nehfams_connection($1,$2,$3,9,$4,false)',[org,actor,'test','1FA'])).rejects.toThrow(/changed/)
 await db.query('select validate_nehfams_connection($1,$2,$3,1,$4,false)',[org,actor,'test','1FA'])
 await db.query('select activate_nehfams_test($1,$2)',[org,actor])
 await expect(db.exec(`update organization_ccc_policy set environment='production'`)).rejects.toThrow(/nehfams_production_disabled/)
 const reserve=()=>db.query(`select reserve_ccc_attendance($1,$2,null,'draft','12345678','NHISCARD',current_date) as r`,[org,actor])
 const parallel=await Promise.allSettled([reserve(),reserve()])
 expect(parallel.filter(x=>x.status==='fulfilled')).toHaveLength(1)
 expect(parallel.filter(x=>x.status==='rejected')).toHaveLength(1)
 const r=parallel.find(x=>x.status==='fulfilled').value.rows[0].r
 expect(r.connection.environment).toBe('test')
 await expect(reserve()).rejects.toThrow(/unresolved/)
 await expect(configure()).rejects.toThrow(/unresolved/)
 await db.query(`update ccc_attendance_requests set status='succeeded',result='{"ccCode":"01234"}' where id=$1`,[r.request_id])
 expect((await reserve()).rows[0].r.cached).toBe(true)
 const insert=(organization=org,branch=null)=>db.query(`insert into nhis_claims(id,organization_id,branch_id,member_no,service_date_from,ccc_no,ccc_attendance_request_id) values(gen_random_uuid(),$1,$2,'12345678',current_date,'01234',$3)`,[organization,branch,r.request_id])
 await expect(insert()).rejects.toThrow(/production attendance/)
 await db.query(`update ccc_attendance_requests set environment='production' where id=$1`,[r.request_id])
 await expect(insert('00000000-0000-0000-0000-000000000002')).rejects.toThrow(/facility and branch/)
 await expect(insert(org,'00000000-0000-0000-0000-000000000002')).rejects.toThrow(/facility and branch/)
 await insert()
 expect((await db.query('select ccc_attendance_request_id from nhis_claims')).rows[0].ccc_attendance_request_id).toBe(r.request_id)
 await configure()
 expect((await db.query('select validated_at from organization_nehfams_connection')).rows[0].validated_at).toBe(null)
 await expect(db.query('select activate_nehfams_test($1,$2)',[org,actor])).rejects.toThrow(/Validate/)
 expect((await db.query("select has_table_privilege('authenticated','organization_nehfams_connection','SELECT') as allowed")).rows[0].allowed).toBe(false)
 } finally { await db.close() }
},30000)
