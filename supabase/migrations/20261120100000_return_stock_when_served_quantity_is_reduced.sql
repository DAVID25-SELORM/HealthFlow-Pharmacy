-- NHIS claim correction: lower or remove a served medicine after stock was deducted, returning the stock.
--
-- Builds on 20261120090000 (raising a served quantity). Until now a pharmacy that served too MUCH could not
-- correct the claim: the correction refused any reduction because the app had no way to put stock back.
--
-- When a correction lowers or removes a medicine on a claim that already moved stock, this now:
--   * requires an Admin (stock is being returned) and a written reason,
--   * returns the difference to the same inventory batches it was taken from, newest deduction first,
--     recording a stock_movements 'return' row and a reversing nhis_inventory_ledger row for each batch
--     (reversal_of_ledger_id points at the deduction it reverses) under one audited serving event,
--   * then replaces the medicine lines exactly as the increase path does, and calls the existing
--     apply_nhis_inventory_serving_effect() so any other line that went UP is deducted in the same save.
--
-- Quantities that were never deducted (served before NHIS stock deduction was switched on, held as the
-- activation baseline) are not returned: only stock the ledger actually took is put back.
-- Claims with no stock movement, header-only corrections and increases behave as before.
-- Patches the live definition in place and aborts if it is not the expected shape.
-- Undo: restore the previous function from 04-rollback.sql of the review pack.
begin;

do $patch$
declare
  definition text;
  declare_marker text := E'  v_stock_moved boolean := false;\n';
  from_marker text := E'    -- Stock was already deducted: allow only an increase of served quantity. No medicine may be removed or reduced.\n';
  to_marker text := E'    v_stock_moved := true;\n';
  pos_from integer;
  pos_to integer;
begin
  select pg_get_functiondef('public.correct_nhis_claim_privileged(uuid,jsonb,jsonb,jsonb,text,timestamptz)'::regprocedure)
    into definition;
  if position('correction-return:' in definition) > 0 then
    return; -- already patched
  end if;
  definition := replace(definition, E'\r\n', E'\n');
  pos_from := position(from_marker in definition);
  pos_to := position(to_marker in definition);
  if position(declare_marker in definition) = 0 or pos_from = 0 or pos_to = 0 or pos_to < pos_from then
    raise exception 'Unexpected privileged NHIS correction definition; return-to-stock patch not applied (apply 20261120090000 first)';
  end if;

  definition := replace(definition, declare_marker, declare_marker
    || E'  v_reduce record;\n'
    || E'  v_batch record;\n'
    || E'  v_drug public.drugs%rowtype;\n'
    || E'  v_remaining numeric;\n'
    || E'  v_take numeric;\n'
    || E'  v_return_event uuid;\n');
  pos_from := position(from_marker in definition);
  pos_to := position(to_marker in definition);

  definition := substr(definition, 1, pos_from - 1) || $new$    -- Stock was already deducted. A raised quantity is deducted by the serving function after the lines are replaced.
    -- A lowered or removed quantity first returns the difference to the batches it came from (newest deduction first).
    for v_reduce in
      select l.medicine_key, l.applied, coalesce(b.served_quantity, 0) as baseline, coalesce(n.served, 0) as new_served
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
      left join public.nhis_inventory_policy_activation_baselines b
        on b.claim_id = p_claim_id and b.claim_medicine_key = l.medicine_key
       and b.activation_id = (
         select a.id from public.nhis_inventory_policy_activations a
         where a.organization_id = v_claim.organization_id
         order by a.enabled_at desc, a.id desc limit 1)
      where l.applied > 0 and coalesce(n.served, 0) < coalesce(b.served_quantity, 0) + l.applied
    loop
      v_remaining := least(v_reduce.applied, v_reduce.baseline + v_reduce.applied - v_reduce.new_served);
      if v_remaining <= 0 then
        continue;
      end if;
      if v_actor_role is distinct from 'admin' then
        raise exception 'Only an Admin can reduce or remove a served NHIS quantity after inventory was deducted.' using errcode = '42501';
      end if;
      if nullif(btrim(coalesce(p_reason, '')), '') is null then
        raise exception 'A reason is required to reduce or remove a served NHIS quantity; the stock is returned to the shelf.' using errcode = '22023';
      end if;
      if v_return_event is null then
        insert into public.nhis_serving_events (
          organization_id, branch_id, claim_id, idempotency_key, source, actor_user_id, payload_hash
        ) values (
          v_claim.organization_id, v_claim.branch_id, p_claim_id,
          concat('correction-return:', p_claim_id::text, ':', v_new.updated_at::text), 'cloud_serve',
          v_actor_id, md5(p_claim_id::text || coalesce(p_reason, ''))
        ) returning id into v_return_event;
      end if;
      for v_batch in
        select l2.inventory_drug_id, sum(l2.quantity_delta) as balance,
               (select x.id from public.nhis_inventory_ledger x
                 where x.claim_id = p_claim_id and x.claim_medicine_key = v_reduce.medicine_key
                   and x.inventory_drug_id = l2.inventory_drug_id and x.quantity_delta < 0
                 order by x.created_at desc, x.id desc limit 1) as last_deduction_id
        from public.nhis_inventory_ledger l2
        where l2.claim_id = p_claim_id and l2.claim_medicine_key = v_reduce.medicine_key
        group by l2.inventory_drug_id
        having sum(l2.quantity_delta) < 0
        order by max(l2.created_at) desc, l2.inventory_drug_id
      loop
        v_take := least(v_remaining, -v_batch.balance);
        select * into v_drug from public.drugs where id = v_batch.inventory_drug_id for update;
        if not found or v_drug.organization_id is distinct from v_claim.organization_id then
          raise exception 'The original inventory item is unavailable in this organization.';
        end if;
        update public.drugs set quantity = coalesce(quantity, 0) + v_take, updated_at = now() where id = v_drug.id;
        insert into public.stock_movements (
          drug_id, movement_type, source_type, quantity, previous_quantity, new_quantity,
          reference_id, notes, created_by, organization_id, branch_id, created_at
        ) values (
          v_drug.id, 'return', 'nhis_dispensing', v_take, coalesce(v_drug.quantity, 0), coalesce(v_drug.quantity, 0) + v_take,
          p_claim_id, concat('NHIS claim corrected, stock returned: ', coalesce(v_claim.claim_number, p_claim_id::text)),
          v_actor_id, v_claim.organization_id, v_drug.branch_id, now()
        );
        insert into public.nhis_inventory_ledger (
          organization_id, branch_id, claim_id, serving_event_id, inventory_drug_id,
          claim_medicine_key, quantity_delta, movement_type, reversal_of_ledger_id, actor_user_id
        ) values (
          v_claim.organization_id, v_drug.branch_id, p_claim_id, v_return_event, v_drug.id,
          v_reduce.medicine_key, v_take, 'nhis_dispensing_reversal', v_batch.last_deduction_id, v_actor_id
        );
        v_remaining := v_remaining - v_take;
        exit when v_remaining <= 0;
      end loop;
      if v_remaining > 0 then
        raise exception 'Could not return the full quantity to stock; review the claim stock history before correcting.' using errcode = '55000';
      end if;
    end loop;
$new$ || substr(definition, pos_to);

  execute definition;
end $patch$;

notify pgrst, 'reload schema';
commit;
