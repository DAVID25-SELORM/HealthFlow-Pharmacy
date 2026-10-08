-- Verified against src/data/nhisDefaultDrugCatalog.js: these two codes are
-- heparin injection 5000 units/mL, in 1 mL and 5 mL packs respectively.
-- Match coverage, not stock quantities or clinical interchangeability.
begin;
do $patch$
declare
  definition text;
  anchor text := 'when v_generic_name <> ''''';
  marker text := '-- Recognize verified heparin concentration across pack sizes.';
begin
  select pg_get_functiondef('public.check_nhis_active_medication_overlap(text,text,text,date,uuid,uuid,text,text,text,numeric,text,text,text)'::regprocedure)
    into definition;
  if position(marker in definition)>0 then return; end if;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
    raise exception 'Unexpected overlap matching definition; heparin pack patch not applied';
  end if;
  definition := replace(definition,anchor,$match$
        -- Recognize verified heparin concentration across pack sizes.
        when v_medicine_code in ('HEPARIIN2','HEPARIIN3')
          and coverage_lines.drug_code_key in ('HEPARIIN2','HEPARIIN3')
          then 'same_ingredient'
        when v_generic_name <> ''$match$);
  execute definition;
end $patch$;
notify pgrst, 'reload schema';
commit;
