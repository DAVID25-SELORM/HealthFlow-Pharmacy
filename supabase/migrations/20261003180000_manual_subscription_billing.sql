-- Manual MoMo subscription billing. No clinical access gates or Hubtel integration.
begin;
create table public.platform_billing_plans (
 organization_id uuid primary key references public.organizations(id),
 monthly_amount numeric(12,2) not null check(monthly_amount>0),
 starts_on date not null, due_day integer not null check(due_day between 1 and 28),
 updated_by uuid not null references public.users(id), updated_at timestamptz not null default now()
);
create table public.platform_billing_audit (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 actor_id uuid not null references public.users(id), action text not null, details jsonb not null,
 created_at timestamptz not null default now()
);
alter table public.platform_billing_audit enable row level security;
revoke all on public.platform_billing_audit from public,anon,authenticated;
create table public.platform_subscription_invoices (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 period date not null, due_on date not null, amount numeric(12,2) not null check(amount>0),
 paid_at timestamptz, created_at timestamptz not null default now(), unique(organization_id,period)
);
create table public.platform_subscription_payments (
 id uuid primary key default gen_random_uuid(), invoice_id uuid not null references public.platform_subscription_invoices(id),
 transaction_reference text not null unique check(length(transaction_reference) between 4 and 100),
 amount numeric(12,2) not null check(amount>0), submitted_by uuid not null references public.users(id),
 submitted_at timestamptz not null default now(), status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reviewed_by uuid references public.users(id), reviewed_at timestamptz, review_note text
);
create unique index platform_subscription_one_pending on public.platform_subscription_payments(invoice_id) where status='pending';
alter table public.platform_billing_plans enable row level security;
alter table public.platform_subscription_invoices enable row level security;
alter table public.platform_subscription_payments enable row level security;
revoke all on public.platform_billing_plans,public.platform_subscription_invoices,public.platform_subscription_payments from public,anon,authenticated;

create function public.platform_billing_generate(p_org uuid) returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare p public.platform_billing_plans%rowtype;
begin
 select * into p from public.platform_billing_plans where organization_id=p_org for update;
 if not found then return; end if;
 insert into public.platform_subscription_invoices(organization_id,period,due_on,amount)
 select p_org,month::date,month::date+(p.due_day-1),p.monthly_amount
 from generate_series(date_trunc('month',p.starts_on::timestamp),date_trunc('month',current_date::timestamp),interval '1 month') month
 on conflict(organization_id,period) do nothing;
end $$;
revoke all on function public.platform_billing_generate(uuid) from public,anon,authenticated;

create function public.platform_billing(p_action text default 'list',p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_catalog as $$
declare u public.users%rowtype; org uuid; inv public.platform_subscription_invoices%rowtype;
 pay public.platform_subscription_payments%rowtype; is_platform boolean; ref text; decision text;
 v_amount numeric; v_start date; v_due integer; next_unpaid date;
begin
 select * into u from public.users where id=auth.uid() and is_active=true;
 if not found then raise exception 'Sign in with an active account.' using errcode='42501'; end if;
 is_platform := u.role='super_admin';
 if not is_platform and not (u.role='admin' or coalesce(u.assigned_roles,'{}') && array['admin']::text[]) then
 raise exception 'Billing is restricted to facility administrators.' using errcode='42501'; end if;
 org := case when is_platform then nullif(p_data->>'organization_id','')::uuid else u.organization_id end;
 if not is_platform and org is null then raise exception 'Facility membership required.'; end if;
 if p_action='set_plan' then
   if not is_platform then raise exception 'Platform administrator required.' using errcode='42501'; end if;
   v_amount:=(p_data->>'amount')::numeric; v_start:=(p_data->>'starts_on')::date; v_due:=(p_data->>'due_day')::integer;
   if org is null or v_amount is null or v_amount<=0 or v_amount<>round(v_amount,2) or v_start is null
      or v_start<date_trunc('month',current_date)::date or v_start>current_date+interval '2 years'
      or v_due is null or v_due not between 1 and 28 then raise exception 'Enter a positive amount, current/future start month and due day 1?28.'; end if;
   -- Generate existing obligations at the old rate before changing future charges.
   perform public.platform_billing_generate(org);
   insert into public.platform_billing_plans values(org,v_amount,v_start,v_due,u.id,now())
   on conflict(organization_id) do update set monthly_amount=excluded.monthly_amount,due_day=excluded.due_day,
     updated_by=u.id,updated_at=now();
   perform public.platform_billing_generate(org);
 elsif p_action='submit' then
   select * into inv from public.platform_subscription_invoices where id=(p_data->>'invoice_id')::uuid for update;
   if not found or (not is_platform and inv.organization_id<>org) then raise exception 'Invoice unavailable.' using errcode='42501'; end if;
   if inv.paid_at is not null then raise exception 'Invoice already paid.'; end if;
   ref:=upper(btrim(p_data->>'reference'));
   if ref is null or length(ref) not between 4 and 100 then raise exception 'Enter a valid MoMo transaction ID.'; end if;
   insert into public.platform_subscription_payments(invoice_id,transaction_reference,amount,submitted_by)
   values(inv.id,ref,inv.amount,u.id);
 elsif p_action='review' then
   if not is_platform then raise exception 'Platform administrator required.' using errcode='42501'; end if;
   -- All payment operations lock invoice first to serialize approval and submissions.
   select * into inv from public.platform_subscription_invoices where id=(select invoice_id from public.platform_subscription_payments where id=(p_data->>'payment_id')::uuid) for update;
   select * into pay from public.platform_subscription_payments where id=(p_data->>'payment_id')::uuid for update;
   if not found then raise exception 'Payment unavailable.'; end if;
   decision:=p_data->>'decision';
   if decision is null or decision not in ('approved','rejected') then raise exception 'Invalid review decision.'; end if;
   if pay.status<>'pending' then raise exception 'Payment already reviewed.'; end if;
   if decision='rejected' and nullif(btrim(p_data->>'note'),'') is null then raise exception 'Give a rejection reason.'; end if;
   if inv.paid_at is not null then raise exception 'Invoice already settled.'; end if;
   update public.platform_subscription_payments set status=decision,reviewed_by=u.id,reviewed_at=now(),review_note=left(p_data->>'note',500) where id=pay.id;
   if decision='approved' then
     update public.platform_subscription_invoices set paid_at=now() where id=inv.id;
     perform public.platform_billing_generate(inv.organization_id);
     select min(period) into next_unpaid from public.platform_subscription_invoices where organization_id=inv.organization_id and paid_at is null;
     update public.organizations set last_payment_at=now(),
       subscription_ends_at=greatest(subscription_ends_at,coalesce(next_unpaid,(date_trunc('month',current_date)+interval '1 month')::date)::timestamptz),
       subscription_updated_by=u.id where id=inv.organization_id;
   end if;
 elsif p_action<>'list' then raise exception 'Unknown billing action.';
 end if;
 if p_action<>'list' then
   insert into public.platform_billing_audit(organization_id,actor_id,action,details)
   values(case when p_action='set_plan' then org else inv.organization_id end,u.id,p_action,
     case when p_action='set_plan' then jsonb_build_object('amount',v_amount,'due_day',v_due,'starts_on',v_start)
     else jsonb_build_object('invoice_id',inv.id,'decision',decision,'reference',ref) end);
 end if;
 if is_platform then
   for org in select organization_id from public.platform_billing_plans loop perform public.platform_billing_generate(org); end loop;
 else perform public.platform_billing_generate(org); end if;
 return jsonb_build_object(
 'recipient',jsonb_build_object('number','0247654381','name','David Selorm Gabion'),
 'facilities',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'amount',p.monthly_amount,'starts_on',p.starts_on,'due_day',p.due_day) order by o.name)
 from public.organizations o left join public.platform_billing_plans p on p.organization_id=o.id where is_platform or o.id=u.organization_id),'[]'),
 'invoices',coalesce((select jsonb_agg(to_jsonb(i)||jsonb_build_object('facility',o.name) order by i.period desc)
 from public.platform_subscription_invoices i join public.organizations o on o.id=i.organization_id where is_platform or i.organization_id=u.organization_id),'[]'),
 'payments',coalesce((select jsonb_agg(to_jsonb(p) order by p.submitted_at desc) from public.platform_subscription_payments p join public.platform_subscription_invoices i on i.id=p.invoice_id where is_platform or i.organization_id=u.organization_id),'[]'));
end $$;
revoke all on function public.platform_billing(text,jsonb) from public,anon,authenticated;
grant execute on function public.platform_billing(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
