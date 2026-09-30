-- Preserve the installed paging function and add CCC/folder to its search fields.
do $migration$
declare
  v_definition text;
  v_marker text := $text$or c.hin ilike '%' || p.search_filter || '%'$text$;
begin
  select pg_get_functiondef('public.get_nhis_claims_page(integer,integer,text,boolean,date,date,text,boolean)'::regprocedure) into v_definition;
  if position(v_marker in v_definition) = 0 then
    raise exception 'NHIS search function differs from expected definition; review before applying.';
  end if;
  if position('or c.ccc_no ilike' in v_definition) = 0 then
    v_definition := replace(v_definition, v_marker, v_marker || $text$
        or c.ccc_no ilike '%' || p.search_filter || '%'
        or c.folder_no ilike '%' || p.search_filter || '%' $text$);
    execute v_definition;
  end if;
end
$migration$;
