-- Attachment/header corrections must not replace medicines already tied to stock.
begin;

create or replace function public.nhis_correction_medicine_values(p_rows jsonb)
returns jsonb language sql stable set search_path = public, pg_catalog as $$
  select coalesce(jsonb_agg(line order by line), '[]'::jsonb)
  from (
    select (
      select jsonb_strip_nulls(jsonb_object_agg(key, value))
      from jsonb_each(to_jsonb(jsonb_populate_record(null::public.nhis_claim_medicines, item)))
      where key = any(array[
        'nhis_drug_id','drug_code','description','unit','unit_price','dispensed_qty',
        'dispensary_date','dose','frequency','duration','total_amount','medicine_access_level',
        'required_pharmacy_level','prescribed_qty','served_qty','serving_status',
        'reason_if_not_fully_served','entered_by_claims_officer','served_by_mca','entered_at','served_at'
      ])
    ) as line
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as rows(item)
  ) normalized;
$$;

do $patch$
declare
  definition text;
  start_marker text := '  delete from public.nhis_claim_medicines where claim_id = p_claim_id;';
  end_marker text := '  delete from public.nhis_claim_services where claim_id = p_claim_id;';
  compare_marker text := '  v_old_json := to_jsonb(v_claim);';
begin
  select pg_get_functiondef('public.correct_nhis_claim_privileged(uuid,jsonb,jsonb,jsonb,text,timestamptz)'::regprocedure)
    into definition;
  if position('public.nhis_correction_medicine_values(v_old_medicines)' in definition) > 0 then
    return;
  end if;
  if position(start_marker in definition) = 0 or position(end_marker in definition) = 0
     or position(compare_marker in definition) = 0 then
    raise exception 'Unexpected privileged NHIS correction definition; medicine preservation patch not applied';
  end if;
  -- Compare typed values, ignoring row order and server-generated identity fields.
  -- Preserve duplicates, clinical directions, quantities, prices and actor traces.
  definition := replace(definition, compare_marker, $compare$
  if public.nhis_correction_medicine_values(v_old_medicines)
     = public.nhis_correction_medicine_values(v_new_medicines) then
    v_new_medicines := v_old_medicines;
  end if;
$compare$ || compare_marker);
  definition := replace(definition, start_marker,
    '  if v_old_medicines is distinct from v_new_medicines then' || chr(10) || start_marker);
  definition := replace(definition, end_marker, '  end if;' || chr(10) || end_marker);
  execute definition;
end $patch$;

revoke all on function public.nhis_correction_medicine_values(jsonb) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
