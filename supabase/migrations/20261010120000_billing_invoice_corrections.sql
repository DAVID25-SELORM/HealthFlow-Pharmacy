begin;
-- Existing invoices need an explicit, audited correction; plan changes remain prospective.
create function public.platform_billing_correct_invoice(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 actor uuid; inv public.platform_subscription_invoices%rowtype;
 amount_new numeric := (p_data->>'amount')::numeric;
 expected numeric := (p_data->>'expected_amount')::numeric;
 note text := nullif(btrim(p_data->>'note'),'');
 receipts jsonb;
begin
 select id into actor from public.users where id=auth.uid() and is_active=true and role='super_admin';
 if actor is null then raise exception 'Platform administrator required.' using errcode='42501'; end if;
 if amount_new is null or amount_new::text in ('NaN','Infinity','-Infinity') or amount_new<=0 or amount_new<>round(amount_new,2)
    or expected is null or note is null or length(note)>500 then raise exception 'Enter the corrected amount and a verification reason.'; end if;
 select * into inv from public.platform_subscription_invoices where id=(p_data->>'invoice_id')::uuid for update;
 if not found then raise exception 'Invoice unavailable.'; end if;
 if inv.amount is distinct from expected then raise exception 'Invoice changed. Refresh billing before correcting it.'; end if;
 if exists(select 1 from public.platform_subscription_payments where invoice_id=inv.id and status='pending') then
  raise exception 'Review the pending payment before correcting this invoice.';
 end if;
 if inv.paid_at is not null and (select count(*) from public.platform_subscription_payments where invoice_id=inv.id and status='approved')<>1 then
  raise exception 'Paid invoice requires exactly one approved receipt for correction.';
 end if;
 if inv.paid_at is null and exists(select 1 from public.platform_subscription_payments where invoice_id=inv.id and status='approved') then
  raise exception 'Invoice payment state needs reconciliation.';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'amount',amount,'reference',transaction_reference)),'[]'::jsonb)
 into receipts from public.platform_subscription_payments where invoice_id=inv.id and status='approved';
 update public.platform_subscription_invoices set amount=amount_new where id=inv.id;
 update public.platform_subscription_payments set amount=amount_new where invoice_id=inv.id and status='approved';
 insert into public.platform_billing_audit(organization_id,actor_id,action,details)
 values(inv.organization_id,actor,'correct_invoice_amount',jsonb_build_object('invoice_id',inv.id,'old_amount',inv.amount,'new_amount',amount_new,'previous_receipts',receipts,'note',note));
 return public.platform_billing('list','{}');
end $$;

create function public.platform_billing_receive_invoice(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 actor uuid; inv public.platform_subscription_invoices%rowtype;
 received date := (p_data->>'received_on')::date;
 reference text := upper(btrim(p_data->>'reference'));
 note text := nullif(btrim(p_data->>'note'),'');
 payment uuid; previous_payment_at timestamptz;
begin
 select id into actor from public.users where id=auth.uid() and is_active=true and role='super_admin';
 if actor is null then raise exception 'Platform administrator required.' using errcode='42501'; end if;
 if received is null or received>current_date or received<date '2000-01-01'
    or reference is null or length(reference) not between 4 and 100 or note is null or length(note)>500 then
  raise exception 'Enter the actual payment date, receipt reference and verification note.';
 end if;
 select * into inv from public.platform_subscription_invoices where id=(p_data->>'invoice_id')::uuid for update;
 if not found then raise exception 'Invoice unavailable.'; end if;
 if inv.amount is distinct from (p_data->>'expected_amount')::numeric then raise exception 'Invoice changed. Refresh billing before recording payment.'; end if;
 if inv.paid_at is not null then raise exception 'Invoice is already paid. No additional payment was recorded.'; end if;
 if exists(select 1 from public.platform_subscription_payments where invoice_id=inv.id and status in ('pending','approved')) then
  raise exception 'Review the existing payment before recording another receipt.';
 end if;
 if inv.kind='subscription' then
  select last_payment_at into previous_payment_at from public.organizations where id=inv.organization_id for update;
 end if;
 -- Reuse normal approval and subscription coverage logic within this transaction.
 perform public.platform_billing('submit',jsonb_build_object('invoice_id',inv.id,'reference',reference));
 select id into strict payment from public.platform_subscription_payments where invoice_id=inv.id and status='pending';
 perform public.platform_billing('review',jsonb_build_object('payment_id',payment,'decision','approved','note',note));
 update public.platform_subscription_payments set received_on=received,receipt_reference=reference where id=payment;
 update public.platform_subscription_invoices set paid_at=received::timestamptz where id=inv.id;
 if inv.kind='subscription' then
  update public.organizations set last_payment_at=greatest(previous_payment_at,received::timestamptz) where id=inv.organization_id;
 end if;
 insert into public.platform_billing_audit(organization_id,actor_id,action,details)
 values(inv.organization_id,actor,'receive_invoice',jsonb_build_object('invoice_id',inv.id,'payment_id',payment,'amount',inv.amount,'received_on',received,'reference',reference,'note',note));
 return public.platform_billing('list','{}');
end $$;
revoke all on function public.platform_billing_correct_invoice(jsonb),public.platform_billing_receive_invoice(jsonb) from public,anon,authenticated;
grant execute on function public.platform_billing_correct_invoice(jsonb),public.platform_billing_receive_invoice(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
