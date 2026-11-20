-- NHIS claim correction: allow INCREASING the served quantity of a claim whose stock is already deducted.
--
-- Today correct_nhis_claim_privileged() cannot change medicines once a claim has an NHIS inventory movement:
-- the guard trigger raises "Use the controlled stock-correction workflow", and the app has no such workflow.
-- A pharmacy that served too little (for example 2 instead of 3) cannot correct the claim.
--
-- This patch lets the correction RPC replace the medicine lines when, and only when, no served quantity goes
-- DOWN and no medicine is removed. After the lines are replaced it calls the existing, audited
-- apply_nhis_inventory_serving_effect(), which deducts only the extra quantity (cumulative serving, ledger,
-- stock_movements, FEFO batch order, "insufficient stock" check, idempotency) and itself rejects any reduction.
--
-- Everything else is unchanged: claims with no stock movement behave as before, header-only corrections behave
-- as before, reductions and removals are still refused (55000), and the guard trigger is untouched.
-- Patches the live definition in place (as 20261008213000 did) and aborts if the definition is not the expected shape.
-- Undo: restore the previous function from 04-rollback.sql of the review pack.
begin;

do $patch$
declare
  definition text;
  declare_marker text := E'  v_has_scalar_changes boolean;\n';
  start_marker text := E'  if v_old_medicines is distinct from v_new_medicines then\n  delete from public.nhis_claim_medicines where claim_id = p_claim_id;';
  end_marker text := E'  end if;\n  delete from public.nhis_claim_services where claim_id = p_claim_id;';
begin
  select pg_get_functiondef('public.correct_nhis_claim_privileged(uuid,jsonb,jsonb,jsonb,text,timestamptz)'::regprocedure)
    into definition;
  if position('correction:' in definition) > 0 then
    return; -- already patched
  end if;
  -- Earlier migrations were authored with Windows line endings and patched with plain newlines, so the live
  -- body mixes both. Normalise to newlines (insignificant in plpgsql) before matching.
  definition := replace(definition, E'\r\n', E'\n');
  if position(declare_marker in definition) = 0 or position(start_marker in definition) = 0
     or position(end_marker in definition) = 0 then
    raise exception 'Unexpected privileged NHIS correction definition; served-quantity increase patch not applied';
  end if;

  definition := replace(definition, declare_marker, declare_marker
    || E'  v_stock_moved boolean := false;\n'
    || E'  v_previous_replacement text;\n');

  definition := replace(definition, start_marker, $start$  if v_old_medicines is distinct from v_new_medicines then
  if exists (select 1 from public.nhis_inventory_ledger where claim_id = p_claim_id) then
    -- Stock was already deducted: allow only an increase of served quantity. No medicine may be removed or reduced.
    if exists (
      select 1
      from (
        select claim_medicine_key as medicine_key, sum(-quantity_delta) as applied
        from public.nhis_inventory_ledger
        where claim_id = p_claim_id
        group by claim_medicine_key
      ) l
      left join (
        select coalesce(nullif(lower(btrim(line.item->>'nhis_drug_id')), ''), upper(nullif(btrim(line.item->>'drug_code'), ''))) as medicine_key,
               sum(coalesce(nullif(line.item->>'served_qty', '')::numeric, 0)) as served
        from jsonb_array_elements(coalesce(p_medicines, '[]'::jsonb)) as line(item)
        group by 1
      ) n on n.medicine_key = l.medicine_key
      where l.applied > 0 and coalesce(n.served, 0) < l.applied
    ) then
      raise exception 'A served NHIS medicine cannot be reduced or removed after inventory was deducted. Only increasing the served quantity is allowed; use the controlled return-to-stock workflow for anything else.' using errcode = '55000';
    end if;
    v_stock_moved := true;
    v_previous_replacement := current_setting('healthflow.nhis_serving_replacement', true);
    perform set_config('healthflow.nhis_serving_replacement', 'true', true);
  end if;
  delete from public.nhis_claim_medicines where claim_id = p_claim_id;$start$);

  definition := replace(definition, end_marker, $end$  if v_stock_moved then
    perform set_config('healthflow.nhis_serving_replacement', coalesce(v_previous_replacement, ''), true);
    perform public.apply_nhis_inventory_serving_effect(
      p_claim_id, concat('correction:', p_claim_id::text, ':', v_new.updated_at::text), 'cloud_serve'
    );
  end if;
  end if;
  delete from public.nhis_claim_services where claim_id = p_claim_id;$end$);

  execute definition;
end $patch$;

notify pgrst, 'reload schema';
commit;
