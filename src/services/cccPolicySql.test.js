// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { it, expect } from 'vitest'

it('enforces tenant isolation, durable deduplication and administrator policy changes', async () => {
 const db = new PGlite()
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table organizations(id uuid primary key);
 create table branches(id uuid primary key, organization_id uuid);
 create table users(id uuid primary key, organization_id uuid, branch_id uuid, role text, is_active boolean);
 create table nhis_claims(id uuid primary key, organization_id uuid, member_no text);
 create type branch_client as (organization_id uuid,branch_id uuid);
 create function get_branch_sync_client(text) returns branch_client language sql as 'select null::uuid,null::uuid';
 insert into organizations values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
 insert into users values ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',null,'admin',true);`)
 await db.exec(readFileSync('supabase/migrations/20261010090000_organization_ccc_providers.sql','utf8'))
 const reserve = (org='00000000-0000-0000-0000-000000000001') => db.query(`select reserve_ccc_attendance($1,'00000000-0000-0000-0000-000000000003',null,'draft','12345678','NHISCARD',(now() at time zone 'Africa/Accra')::date) as result`,[org])
 await expect(reserve('00000000-0000-0000-0000-000000000002')).rejects.toThrow(/membership/)
 const first=await reserve(); expect(first.rows[0].result.cached).toBe(false)
 await expect(reserve()).rejects.toThrow(/unresolved/)
 await expect(db.query(`select save_ccc_policy('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','otac',true,null,null,'1','Test')`)).rejects.toThrow(/administrator/)
 await db.exec(`update ccc_attendance_requests set status='succeeded',result='{"ccCode":"12345"}';`)
 expect((await reserve()).rows[0].result.result.ccCode).toBe('12345')
 const permissions=await db.query(`select has_table_privilege('authenticated','organization_ccc_policy','SELECT') as can_read,has_function_privilege('authenticated','reserve_ccc_attendance(uuid,uuid,uuid,text,text,text,date)','EXECUTE') as can_reserve`)
 expect(permissions.rows[0]).toEqual({can_read:false,can_reserve:false})
 } finally { await db.close() }
},30000)
