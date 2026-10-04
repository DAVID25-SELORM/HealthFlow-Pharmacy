-- READ ONLY. Run in Supabase SQL Editor. No patient data or SMTP secrets.
select 'export_audit_last_24h' as check_name, jsonb_build_object(
 'claim_events',count(*),'artifacts',count(distinct artifact_sha256),'latest',max(created_at)
) as details from public.nhis_cxf_events
where event_type in ('CXF_EXPORTED','CXF_REEXPORTED') and created_at>now()-interval '24 hours'
union all
select 'alerts_last_24h',jsonb_build_object('count',count(*),'latest',max(created_at))
from public.claim_export_alerts where created_at>now()-interval '24 hours'
union all
select 'mail_queue_'||status,jsonb_build_object('count',count(*),'max_attempts',max(attempts),
 'last_sent',max(sent_at),'last_error',max(last_error))
from public.claim_export_mail_queue group by status;

select a.facility_name,a.period,a.claim_count,a.created_at,
 count(q.id) as queued_emails,
 count(q.id) filter(where q.status='sent') as smtp_accepted,
 count(q.id) filter(where q.status='pending') as pending,
 count(q.id) filter(where q.status='failed') as failed,
 max(q.attempts) as attempts
from public.claim_export_alerts a left join public.claim_export_mail_queue q on q.alert_id=a.id
group by a.id order by a.created_at desc limit 10;
