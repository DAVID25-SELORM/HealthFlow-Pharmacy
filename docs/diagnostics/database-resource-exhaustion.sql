-- Run each numbered section separately in the affected project's SQL Editor.
-- Read-only: no changes to data, permissions, indexes, or statistics.
-- Capture sections 1-3 during slowness if possible.
-- Statistics are cumulative, not limited to the incident. Compare two captures
-- a few minutes apart. Failed statements may not appear in pg_stat_statements;
-- correlate with API/Postgres logs. Review query text before sharing results.

-- 1. Queries consuming the most total execution time (not a direct CPU measure).
-- If the view is not found, check its extension schema using section 5.
select queryid, calls,
       round(total_exec_time::numeric, 2) as total_exec_ms,
       round(mean_exec_time::numeric, 2) as mean_exec_ms,
       round(max_exec_time::numeric, 2) as max_exec_ms,
       rows, shared_blks_hit, shared_blks_read, temp_blks_written,
       left(query, 3000) as query
from extensions.pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
order by total_exec_time desc
limit 25;

-- 2. Connection counts and waits, without request text or patient values.
select usename, application_name, state, wait_event_type, wait_event,
       count(*) as connections
from pg_stat_activity
where datname = current_database()
group by usename, application_name, state, wait_event_type, wait_event
order by connections desc;

-- 3. Long-running work / open transactions and blocking process IDs.
select pid, usename, application_name, state, wait_event_type, wait_event,
       now() - xact_start as transaction_age,
       now() - query_start as query_age,
       pg_blocking_pids(pid) as blocking_pids
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid()
  and (state = 'active' or state like 'idle in transaction%')
order by xact_start nulls last
limit 50;

-- 4. Actual deployed drug-table policies, defaults, and custom triggers.
-- Inspect INSERT WITH CHECK and UPDATE USING/WITH CHECK for upserts.
select policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'nhis_drugs';

select column_name, column_default, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'nhis_drugs'
  and column_name in ('id', 'organization_id', 'code');

select t.tgname, pg_get_triggerdef(t.oid) as trigger_definition
from pg_trigger t
where t.tgrelid = 'public.nhis_drugs'::regclass and not t.tgisinternal;

-- 5. Extension schema, if section 1 cannot resolve pg_stat_statements.
-- Qualify that view with the returned schema, e.g. extensions.pg_stat_statements.
select e.extname, n.nspname as extension_schema
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_stat_statements';
