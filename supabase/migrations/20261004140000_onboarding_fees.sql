-- Apply after historical receipt migrations. Keep onboarding separate from subscription coverage.
begin;
alter table public.platform_subscription_invoices add column kind text not null default 'subscription' check(kind in ('subscription','onboarding'));
alter table public.platform_subscription_invoices drop constraint platform_subscription_invoices_organization_id_period_key;
alter table public.platform_subscription_invoices add unique(organization_id,period,kind);
create unique index platform_one_onboarding_fee on public.platform_subscription_invoices(organization_id) where kind='onboarding';
do $$
declare signature text; definition text;
begin
 foreach signature in array array['public.platform_billing_generate(uuid)','public.platform_billing_record_history(jsonb)','public.platform_billing(text,jsonb)'] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if signature in ('public.platform_billing_generate(uuid)','public.platform_billing_record_history(jsonb)')
     and position('on conflict(organization_id,period) do nothing' in definition)=0 then
    raise exception 'Unexpected invoice generation definition in %. Inspect before migrating.',signature;
  end if;
  if signature='public.platform_billing_record_history(jsonb)' and position('i.period=v_period for update' in definition)=0 then
    raise exception 'Unexpected historical invoice lookup. Inspect before migrating.';
  end if;
  if signature='public.platform_billing(text,jsonb)' and (
    position('perform public.platform_billing_generate(inv.organization_id);' in definition)=0 or
    position('where organization_id=inv.organization_id and paid_at is null' in definition)=0 or
    position('subscription_updated_by=u.id where id=inv.organization_id;' in definition)=0) then
    raise exception 'Unexpected subscription approval definition. Inspect before migrating.';
  end if;
  definition:=replace(definition,'on conflict(organization_id,period) do nothing','on conflict(organization_id,period,kind) do nothing');
  definition:=replace(definition,'i.period=v_period for update','i.period=v_period and i.kind=''subscription'' for update');
  definition:=replace(definition,'perform public.platform_billing_generate(inv.organization_id);','if inv.kind=''subscription'' then perform public.platform_billing_generate(inv.organization_id);');
  definition:=replace(definition,'where organization_id=inv.organization_id and paid_at is null','where organization_id=inv.organization_id and kind=''subscription'' and paid_at is null');
  definition:=replace(definition,'subscription_updated_by=u.id where id=inv.organization_id;','subscription_updated_by=u.id where id=inv.organization_id; end if;');
  execute definition;
 end loop;
end $$;
create function public.platform_billing_onboarding(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare actor uuid; org uuid:=(p_data->>'organization_id')::uuid;
 amount numeric:=(p_data->>'amount')::numeric; due date:=(p_data->>'due_on')::date;
 received date:=nullif(p_data->>'received_on','')::date;
 reference text:=upper(nullif(btrim(p_data->>'reference'),''));
 note text:=nullif(btrim(p_data->>'note'),''); invoice uuid;
begin
 select id into actor from public.users where id=auth.uid() and is_active=true and role='super_admin';
 if actor is null then raise exception 'Platform administrator required.' using errcode='42501'; end if;
 if org is null or amount is null or amount::text in ('NaN','Infinity','-Infinity') or amount<=0 or amount<>round(amount,2) or due is null then
  raise exception 'Choose a facility, a positive fee and a due date.';
 end if;
 if received is not null and (received>current_date or reference is null or length(reference) not between 4 and 100 or note is null) then
  raise exception 'An already-paid fee needs a past payment date, receipt reference and verification note.';
 end if;
 if exists(select 1 from public.platform_subscription_invoices where organization_id=org and kind='onboarding') then
  raise exception 'This facility already has an onboarding fee. Use its existing invoice to record or review payment.';
 end if;
 insert into public.platform_subscription_invoices(organization_id,period,due_on,amount,kind,paid_at)
 values(org,date_trunc('month',due)::date,due,amount,'onboarding',received::timestamptz) returning id into invoice;
 if received is not null then
  insert into public.platform_subscription_payments(invoice_id,transaction_reference,receipt_reference,amount,submitted_by,status,reviewed_by,reviewed_at,review_note,received_on)
  values(invoice,reference,reference,amount,actor,'approved',actor,now(),note,received);
 end if;
 insert into public.platform_billing_audit(organization_id,actor_id,action,details)
 values(org,actor,'onboarding_fee',jsonb_build_object('invoice_id',invoice,'amount',amount,'received_on',received,'reference',reference,'note',note));
 return public.platform_billing('list','{}');
end $$;
revoke all on function public.platform_billing_onboarding(jsonb) from public,anon,authenticated;
grant execute on function public.platform_billing_onboarding(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
