-- Keep existing RLS authoritative. Payment and status commit or roll back together.
begin;
create or replace function public.mark_nhis_claim_paid(p_claim_id uuid)
returns jsonb language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_claim public.nhis_claims%rowtype; v_paid numeric; v_outstanding numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode = '42501'; end if;
  select * into v_claim from public.nhis_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found or access denied.' using errcode = '42501'; end if;
  select coalesce(sum(paid_amount),0) into v_paid from public.nhis_claim_payments where nhis_claim_id=p_claim_id;
  v_outstanding := greatest(0, v_claim.total_amount-v_paid);
  update public.nhis_claims set status='paid', updated_at=now() where id=p_claim_id returning * into v_claim;
  if not found then raise exception 'Claim update denied.' using errcode = '42501'; end if;
  if v_outstanding > 0 then
    insert into public.nhis_claim_payments(organization_id,branch_id,nhis_claim_id,insurer_name,
      approved_amount,paid_amount,payment_date,payment_method,notes,created_by)
    values(v_claim.organization_id,v_claim.branch_id,v_claim.id,'NHIS',v_claim.total_amount,
      v_outstanding,(now() at time zone 'Africa/Accra')::date,'bank_transfer','Marked paid from NHIS claims.',auth.uid());
  end if;
  return to_jsonb(v_claim);
end $$;
revoke all on function public.mark_nhis_claim_paid(uuid) from public, anon;
grant execute on function public.mark_nhis_claim_paid(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
