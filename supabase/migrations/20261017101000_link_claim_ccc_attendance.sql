begin;
alter table public.nhis_claims add column ccc_attendance_request_id uuid references public.ccc_attendance_requests(id) on delete restrict;
create index nhis_claims_ccc_attendance_request_idx on public.nhis_claims(ccc_attendance_request_id) where ccc_attendance_request_id is not null;
create function public.link_claim_ccc_attendance() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare r public.ccc_attendance_requests%rowtype;
begin
 -- Historical/manual claims without matching ledger evidence remain unchanged.
 if new.ccc_attendance_request_id is null then
  select * into r from public.ccc_attendance_requests
   where organization_id=new.organization_id
    and member_number=new.member_no and attendance_date=new.nhia_attendance_date
    and status='succeeded' and result->>'ccCode'=new.ccc_no
    and (branch_id is null or branch_id is not distinct from new.branch_id)
    and (new.card_type is null or card_type=new.card_type)
   order by created_at desc limit 1 for share;
  if not found then return new; end if;
  new.ccc_attendance_request_id:=r.id;
 else
  select * into r from public.ccc_attendance_requests where id=new.ccc_attendance_request_id for share;
 end if;
 if not found or r.organization_id is distinct from new.organization_id
  or (r.branch_id is not null and r.branch_id is distinct from new.branch_id)
  or r.member_number is distinct from new.member_no
  or (new.card_type is not null and r.card_type is distinct from new.card_type)
  or r.attendance_date is distinct from new.nhia_attendance_date
  or r.status is distinct from 'succeeded' or (r.result->>'ccCode') is distinct from new.ccc_no
 then raise exception 'Claim attendance link does not match verified attendance'; end if;
 return new;
end $$;
revoke all on function public.link_claim_ccc_attendance() from public,anon,authenticated;
create trigger link_claim_ccc_attendance before insert or update of ccc_attendance_request_id,organization_id,branch_id,member_no,card_type,nhia_attendance_date,ccc_no on public.nhis_claims for each row execute function public.link_claim_ccc_attendance();
commit;
