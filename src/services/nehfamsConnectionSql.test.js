// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { it, expect } from 'vitest'
it('isolates NeHFAMS secrets, preserves old credentials and prevents unsafe selection', async () => {
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
 await db.exec(readFileSync('supabase/migrations/20261020200000_prepare_nehfams_connection.sql','utf8'))
 const org='00000000-0000-0000-0000-000000000001', actor='00000000-0000-0000-0000-000000000003'
 const save=(key='encrypted-key',secret='encrypted-secret')=>db.query('select save_nehfams_connection($1,$2,$3,$4)',[org,actor,key,secret])
 await expect(save()).rejects.toThrow(/administrator/)
 await db.exec(`update users set role='super_admin'; insert into organization_ccc_policy(organization_id,token_encrypted,expected_hpn,expected_facility_name) values ('${org}','old-otac','295','Synthetic facility')`)
 await expect(save(null,null)).rejects.toThrow(/required/)
 await save()
 expect((await db.query('select provider,enabled,token_encrypted,expected_hpn from organization_ccc_policy')).rows[0]).toEqual({provider:'nehfams',enabled:false,token_encrypted:'old-otac',expected_hpn:'295'})
 await expect(db.exec(`update organization_ccc_policy set enabled=true`)).rejects.toThrow(/nehfams_generation_disabled/)
 await expect(db.query(`select reserve_ccc_attendance($1,$2,null,'draft','12345678','NHISCARD',current_date)`,[org,actor])).rejects.toThrow(/disabled/)
 await save(null,null)
 expect((await db.query('select api_key_encrypted from organization_nehfams_connection')).rows[0].api_key_encrypted).toBe('encrypted-key')
 expect((await db.query("select count(*)::int as count from organization_nehfams_connection where organization_id='00000000-0000-0000-0000-000000000002'")).rows[0].count).toBe(0)
 await db.query(`select save_ccc_policy($1,$2,'existing',true,null,null,'295','Synthetic facility')`,[org,actor])
 await db.query(`select reserve_ccc_attendance($1,$2,null,'draft','12345678','NHISCARD',current_date)`,[org,actor])
 await expect(save()).rejects.toThrow(/unresolved/)
 const audit=JSON.stringify((await db.query('select details from ccc_policy_audit')).rows)
 expect(audit).not.toContain('encrypted-key'); expect(audit).not.toContain('encrypted-secret')
 expect((await db.query("select has_table_privilege('authenticated','organization_nehfams_connection','SELECT') as allowed")).rows[0].allowed).toBe(false)
 } finally { await db.close() }
},30000)
