do $$
declare
  v_function_definition text;
begin
  select pg_get_functiondef(
    'public.branch_sync_upsert_nhia_configuration(text,jsonb)'::regprocedure
  )
  into v_function_definition;

  if position(
    'api_key_encrypted = excluded.api_key_encrypted'
    in v_function_definition
  ) = 0 or position(
    'api_secret_encrypted = excluded.api_secret_encrypted'
    in v_function_definition
  ) = 0 or position(
    'password_encrypted = excluded.password_encrypted'
    in v_function_definition
  ) = 0 then
    raise exception 'Unexpected branch_sync_upsert_nhia_configuration definition.';
  end if;

  v_function_definition := replace(
    v_function_definition,
    'api_key_encrypted = excluded.api_key_encrypted',
    'api_key_encrypted = coalesce(nhia_configuration.api_key_encrypted, excluded.api_key_encrypted)'
  );
  v_function_definition := replace(
    v_function_definition,
    'api_secret_encrypted = excluded.api_secret_encrypted',
    'api_secret_encrypted = coalesce(nhia_configuration.api_secret_encrypted, excluded.api_secret_encrypted)'
  );
  v_function_definition := replace(
    v_function_definition,
    'has_api_key = excluded.has_api_key',
    'has_api_key = nhia_configuration.has_api_key or excluded.has_api_key'
  );
  v_function_definition := replace(
    v_function_definition,
    'has_api_secret = excluded.has_api_secret',
    'has_api_secret = nhia_configuration.has_api_secret or excluded.has_api_secret'
  );
  v_function_definition := replace(
    v_function_definition,
    'username = excluded.username',
    'username = coalesce(nhia_configuration.username, excluded.username)'
  );
  v_function_definition := replace(
    v_function_definition,
    'password_encrypted = excluded.password_encrypted',
    'password_encrypted = coalesce(nhia_configuration.password_encrypted, excluded.password_encrypted)'
  );

  execute v_function_definition;
end;
$$;
