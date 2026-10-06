-- Keep fulfillment metadata inside the same transaction as stock deduction.
begin;
do $migration$
declare definition text;
begin
 select pg_get_functiondef('public.serve_nhis_claim_direct(uuid)'::regprocedure) into definition;
 if position('        served_at = v_served_at,' in definition)=0
    or position('  perform public.assert_nhis_ccc_for_progress(v_claim.ccc_no);' in definition)=0 then
  raise exception 'Unexpected direct serving definition; inspect before applying.';
 end if;
 definition:=replace(definition,'        served_at = v_served_at,',
   E'        served_at = v_served_at,\n        served_by_mca = auth.uid(),');
 definition:=replace(definition,'  perform public.assert_nhis_ccc_for_progress(v_claim.ccc_no);',
   E'  if nullif(btrim(v_claim.folder_no), '''') is null then\n    raise exception ''Folder number is required before serving this NHIS claim.'' using errcode = ''23514'';\n  end if;\n  perform public.assert_nhis_ccc_for_progress(v_claim.ccc_no);');
 execute definition;
end $migration$;
notify pgrst, 'reload schema';
commit;
