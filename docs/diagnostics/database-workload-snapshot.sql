-- Run this entire file, export the result, then repeat after 5 minutes.
-- One read-only result set. Do not reset statistics between captures.
-- Includes database user and nesting level to distinguish identical query IDs.
select now() as captured_at,
       info.stats_reset, info.dealloc,
       s.userid, s.toplevel, s.queryid, s.calls,
       round(s.total_exec_time::numeric, 2) as total_exec_ms,
       round(s.mean_exec_time::numeric, 2) as mean_exec_ms,
       s.shared_blks_hit, s.shared_blks_read, s.temp_blks_written,
       left(s.query, 3000) as query
from extensions.pg_stat_statements s
cross join extensions.pg_stat_statements_info info
where s.dbid = (select oid from pg_database where datname = current_database())
order by s.total_exec_time desc
limit 100;
