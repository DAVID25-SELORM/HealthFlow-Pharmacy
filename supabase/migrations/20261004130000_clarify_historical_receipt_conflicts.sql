-- Explain why a historical receipt cannot be saved, without changing payment rules.
begin;
create or replace function public.platform_billing_record_history(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 actor uuid; org uuid := (p_data->>'organization_id')::uuid;
 first_month date := (p_data->>'first_month')::date;
 months integer := (p_data->>'months')::integer;
 monthly numeric := (p_data->>'monthly_amount')::numeric;
 received date := (p_data->>'received_on')::date;
 reference text := upper(btrim(p_data->>'reference'));
 note text := nullif(btrim(p_data->>'note'),'');
 v_period date; invoice public.platform_subscription_invoices%rowtype; n integer;
begin
 select id into actor from public.users where id=auth.uid() and is_active=true and role='super_admin';
 if actor is null then raise exception 'Platform administrator required.' using errcode='42501'; end if;
 if org is null or first_month is null or first_month<>date_trunc('month',first_month)::date
    or first_month<date '2000-01-01' or first_month>current_date
    or months is null or months not between 1 and 120
    or monthly is null or monthly::text in ('NaN','Infinity','-Infinity') or monthly<=0 or monthly<>round(monthly,2)
    or received is null or received>current_date or received<date '2000-01-01'
    or reference is null or length(reference) not between 4 and 100 or note is null or length(note)>500 then
   raise exception 'Enter a valid start month, 1-120 months, monthly amount, past payment date, reference and verification note.';
 end if;
 -- Serialize history for this facility; normal submissions serialize on each invoice.
 perform 1 from public.organizations where id=org for update;
 if not found then raise exception 'Facility unavailable.'; end if;
 for n in 0..months-1 loop
   v_period := (first_month + make_interval(months=>n))::date;
   insert into public.platform_subscription_invoices(organization_id,period,due_on,amount)
   values(org,v_period,v_period,monthly) on conflict(organization_id,period) do nothing;
   select * into strict invoice from public.platform_subscription_invoices i
     where i.organization_id=org and i.period=v_period for update;
   if invoice.paid_at is not null then
     raise exception 'Month % is already marked paid (payment date: %). Check its invoice receipt before trying again. No additional payment was saved.',v_period,invoice.paid_at::date;
   end if;
   if invoice.amount<>monthly then
     raise exception 'Month % has an invoice for GHS %, but you entered GHS % per month. No payment was saved.',v_period,invoice.amount,monthly;
   end if;
   if exists (select 1 from public.platform_subscription_payments where invoice_id=invoice.id and status='pending') then
     raise exception 'Month % has a payment awaiting review. Review that submission before recording another receipt. No payment was saved.',v_period;
   end if;
   -- The actual reference is reserved in the existing unique index, preventing reuse
   -- through either the historical or ordinary submission workflow.
   insert into public.platform_subscription_payments(invoice_id,transaction_reference,receipt_reference,amount,
     submitted_by,status,reviewed_by,reviewed_at,review_note,received_on)
   values(invoice.id,case when n=0 then reference else 'HIST-'||gen_random_uuid()::text end,reference,monthly,
     actor,'approved',actor,now(),note,received);
   update public.platform_subscription_invoices set paid_at=received::timestamptz where id=invoice.id;
 end loop;
 update public.organizations set last_payment_at=greatest(last_payment_at,received::timestamptz),subscription_updated_by=actor where id=org;
 insert into public.platform_billing_audit(organization_id,actor_id,action,details)
 values(org,actor,'record_history',jsonb_build_object('first_month',first_month,'months',months,
   'monthly_amount',monthly,'total',monthly*months,'received_on',received,'reference',reference,'note',note));
 return public.platform_billing('list','{}');
end $$;
revoke all on function public.platform_billing_record_history(jsonb) from public,anon,authenticated;
grant execute on function public.platform_billing_record_history(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;

