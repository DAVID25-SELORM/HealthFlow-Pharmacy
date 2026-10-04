// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { it,expect } from 'vitest'
it('queues only audited exports, deduplicates recipients and isolates notification access',async()=>{
 const db=new PGlite()
 try {
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select current_setting('test.actor')::uuid$$;
 create table organizations(id uuid primary key,name text);
 create table users(id uuid primary key,organization_id uuid,is_active boolean,role text,assigned_roles text[],email text);
 create table nhis_claims(id uuid primary key,organization_id uuid,service_date_from date);
 create table nhis_cxf_events(claim_id uuid,organization_id uuid,actor_id uuid,event_type text,artifact_sha256 text);
 insert into organizations values('00000000-0000-0000-0000-000000000001','Facility A'),('00000000-0000-0000-0000-000000000002','Facility B');
 insert into users values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',true,'admin','{}','admin@example.com'),('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002',true,'admin','{}','other@example.com');
 insert into nhis_claims values('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','2026-06-01');
 select set_config('test.actor','00000000-0000-0000-0000-000000000003',false);`)
 await db.exec(readFileSync('supabase/migrations/20261004160000_claim_export_notifications.sql','utf8'))
 const complete=()=>db.query('select complete_claim_export_alert($1::uuid[],$2)',[['00000000-0000-0000-0000-000000000005'],'a'.repeat(64)])
 await expect(complete()).rejects.toThrow('entire export')
 await db.query("insert into nhis_cxf_events values('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','CXF_EXPORTED',$1)",['a'.repeat(64)])
 await complete();await complete()
 expect((await db.query('select * from claim_export_alerts')).rows).toHaveLength(1)
 expect((await db.query('select * from claim_export_mail_queue')).rows).toHaveLength(2)
 const jobs=(await db.query('select claim_export_mail_batch() as job')).rows
 expect(jobs).toHaveLength(2);expect((await db.query('select claim_export_mail_batch()')).rows).toHaveLength(0)
 const job=jobs[0].job
 await db.query('select finish_claim_export_mail($1,$2,true)',[job.id,job.lease])
 expect((await db.query("select * from claim_export_mail_queue where status='sent'")).rows).toHaveLength(1)
 await db.exec("update claim_export_mail_queue set attempts=5,available_at=now()-interval '1 minute' where status='sending'")
 await db.query('select claim_export_mail_batch()')
 expect((await db.query("select * from claim_export_mail_queue where status='failed'")).rows).toHaveLength(1)
 const alerts=(await db.query('select list_claim_export_alerts() as alerts')).rows[0].alerts
 expect(alerts).toHaveLength(1)
 await db.query('select list_claim_export_alerts($1)',[alerts[0].id])
 expect((await db.query('select list_claim_export_alerts() as alerts')).rows[0].alerts).toHaveLength(0)
 await db.exec("select set_config('test.actor','00000000-0000-0000-0000-000000000004',false)")
 expect((await db.query('select list_claim_export_alerts() as alerts')).rows[0].alerts).toHaveLength(0)
 await expect(complete()).rejects.toThrow()
 }finally{await db.close()}
},30000)
