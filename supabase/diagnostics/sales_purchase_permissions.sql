-- Read-only post-migration check. Expected: false, true, true for each row.
select p.oid::regprocedure as function_signature,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as staff_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_can_execute
from pg_proc p
where p.oid in (
  'public.create_sale_transaction(jsonb)'::regprocedure,
  'public.complete_purchase(uuid)'::regprocedure
);
