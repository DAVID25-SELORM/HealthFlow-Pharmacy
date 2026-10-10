begin;
-- Limited dashboard projection; pharmacists cannot manage platform billing.
create function public.get_my_outstanding_bills() returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare u public.users%rowtype; bills jsonb;
begin
 select * into u from public.users where id=auth.uid() and is_active=true;
 if not found or u.organization_id is null or not (
   u.role in ('admin','pharmacist') or coalesce(u.assigned_roles,'{}'::text[]) && array['admin','pharmacist']
 ) then raise exception 'Facility administrator or pharmacist required.' using errcode='42501'; end if;
 perform public.platform_billing_generate(u.organization_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'period',i.period,
 'due_on',i.due_on,'amount',i.amount,'awaiting_confirmation',exists(
 select 1 from public.platform_subscription_payments p where p.invoice_id=i.id and p.status='pending'))
 order by i.due_on,i.id),'[]'::jsonb) into bills
 from public.platform_subscription_invoices i where i.organization_id=u.organization_id and i.paid_at is null;
 return bills;
end $$;
revoke all on function public.get_my_outstanding_bills() from public,anon,authenticated;
grant execute on function public.get_my_outstanding_bills() to authenticated;
notify pgrst,'reload schema';
commit;
