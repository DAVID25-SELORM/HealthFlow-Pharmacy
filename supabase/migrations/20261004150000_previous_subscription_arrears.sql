-- Explicitly entered arrears only; never overwrite an existing monthly invoice.
begin;
create function public.platform_billing_arrears(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 v_actor uuid; v_org uuid := (p_data->>'organization_id')::uuid;
 v_first date := (p_data->>'first_month')::date;
 v_months integer := (p_data->>'months')::integer;
 v_amount numeric := (p_data->>'monthly_amount')::numeric;
 v_due date := (p_data->>'due_on')::date;
 v_note text := nullif(btrim(p_data->>'note'),'');
 v_period date; v_id uuid; v_ids uuid[] := '{}'; n integer;
begin
 select id into v_actor from public.users where id=auth.uid() and is_active=true and role='super_admin';
 if v_actor is null then raise exception 'Platform administrator required.' using errcode='42501'; end if;
 if v_org is null or v_first is null or not isfinite(v_first) or v_first<date '2000-01-01'
    or v_first<>date_trunc('month',v_first)::date or v_months is null or v_months not between 1 and 120
    or v_amount is null or v_amount::text in ('NaN','Infinity','-Infinity') or v_amount<=0
    or v_amount>9999999999.99 or v_amount<>round(v_amount,2)
    or v_due is null or not isfinite(v_due) or v_due<date '2000-01-01'
    or v_note is null or length(v_note)>500 then
  raise exception 'Enter a valid first unpaid month, 1-120 months, positive monthly amount, due date and reason.';
 end if;
 if v_first+make_interval(months=>v_months-1)>=date_trunc('month',current_date) then
  raise exception 'Previous outstanding charges must end before the current month. Use the monthly plan for current and future charges.';
 end if;
 perform 1 from public.organizations where id=v_org for update;
 if not found then raise exception 'Facility unavailable.'; end if;
 for n in 0..v_months-1 loop
  v_period := (v_first+make_interval(months=>n))::date;
  v_id := null;
  insert into public.platform_subscription_invoices(organization_id,period,due_on,amount,kind)
  values(v_org,v_period,v_due,v_amount,'subscription')
  on conflict(organization_id,period,kind) do nothing returning id into v_id;
  if v_id is null then
   raise exception 'An invoice already exists for %. No charges were added. Review the existing invoice and choose only unrecorded months.',v_period;
  end if;
  v_ids:=array_append(v_ids,v_id);
 end loop;
 insert into public.platform_billing_audit(organization_id,actor_id,action,details)
 values(v_org,v_actor,'record_arrears',jsonb_build_object('first_month',v_first,'months',v_months,
  'monthly_amount',v_amount,'total',v_amount*v_months,'due_on',v_due,'note',v_note,'invoice_ids',v_ids));
 return public.platform_billing('list','{}');
end $$;
revoke all on function public.platform_billing_arrears(jsonb) from public,anon,authenticated;
grant execute on function public.platform_billing_arrears(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
