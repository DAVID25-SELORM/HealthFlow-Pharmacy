-- Read-only post-migration verification. Both client columns must be false;
-- service_can_execute must be true for both rows.
select p.oid::regprocedure as function_signature,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as staff_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('complete_epharmacy_order', 'complete_customer_epharmacy_order');
