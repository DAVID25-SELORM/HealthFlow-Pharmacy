-- Disposable empty database only. No production data.
\set ON_ERROR_STOP on
create schema auth;
create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function public.user_organization_id() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000002'::uuid $$;
create table public.users(id uuid, organization_id uuid, role text, assigned_roles text[], is_active boolean, can_manage_claims boolean);
insert into users values(auth.uid(),user_organization_id(),'admin','{}',true,true);
create table public.nhis_claims(id uuid primary key, organization_id uuid, ccc_no text, status text, serving_status text, direct_served_at timestamptz, prescription_file_path text);
create table public.nhis_claim_medicines(id serial, claim_id uuid, served_qty numeric, serving_status text);
insert into nhis_claims values('00000000-0000-0000-0000-000000000009',user_organization_id(),null,'served','fully_served',null,null);
create table stock(quantity integer);
insert into stock values(50);
create function deduct_fixture_stock() returns trigger language plpgsql as $$ begin update stock set quantity=quantity-1; return new; end $$;
create trigger fixture_stock after insert on nhis_claim_medicines for each row execute function deduct_fixture_stock();
\ir ../migrations/20260912170000_enforce_nhis_ccc_transitions.sql
insert into nhis_claims values(auth.uid(),user_organization_id(),null,'draft','pending',null,null);
do $$ begin
 if not exists(select 1 from nhis_claims where id='00000000-0000-0000-0000-000000000009' and ccc_no is null and status='served') then raise exception 'Historical record changed'; end if;
 -- Attachments can persist to draft; they cannot mark it complete.
 update nhis_claims set prescription_file_path='fixture.pdf' where id=auth.uid();
 if (select status from nhis_claims where id=auth.uid()) <> 'draft' then raise exception 'Attachment advanced draft'; end if;
 begin update nhis_claims set status='served' where id=auth.uid(); raise exception 'Completion bypass'; exception when check_violation then null; end;
 begin perform serve_nhis_claim_direct(auth.uid()); raise exception 'Direct serve bypass'; exception when check_violation then null; end;
 begin perform serve_nhis_claim_medicines(auth.uid(),'[]',0); raise exception 'Serve bypass'; exception when check_violation then null; end;
 begin insert into nhis_claim_medicines(claim_id,served_qty,serving_status) values(auth.uid(),1,'fully_served'); raise exception 'Medicine bypass'; exception when check_violation then null; end;
 if (select quantity from stock) <> 50 then raise exception 'Stock changed'; end if;
 update nhis_claims set ccc_no='12345',status='served' where id=auth.uid();
 begin update nhis_claims set ccc_no='',prescription_file_path='replacement.pdf' where id=auth.uid(); raise exception 'CCC removal stayed complete'; exception when check_violation then null; end;
 insert into nhis_claim_medicines(claim_id,served_qty,serving_status) values(auth.uid(),1,'fully_served');
 if (select quantity from stock) <> 49 then raise exception 'Valid serving did not run'; end if;
 -- Existing authorization rejects another organization before checking its CCC.
 insert into nhis_claims values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',null,'draft','pending',null,null);
 begin perform serve_nhis_claim_direct('00000000-0000-0000-0000-000000000003'); raise exception 'Cross-org bypass'; exception when raise_exception then if sqlerrm='Cross-org bypass' then raise; end if; end;
end $$;
select 'PASS: drafts, attachments, completion, serving RPCs, direct writes, stock rollback and cross-org rejection';
