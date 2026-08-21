-- Preserve each NHIS POS settlement bucket independently.  The legacy
-- insurance columns remain for compatibility with non-NHIS insurance sales.
alter table public.organizations
  add column if not exists nhis_top_up_policy text not null default 'not_allowed'
    check (nhis_top_up_policy in ('not_allowed', 'allowed', 'required_when_nhis_below_selling_value'));

alter table public.sales
  add column if not exists nhis_covered_amount numeric(12,2) not null default 0,
  add column if not exists nhis_top_up_amount numeric(12,2) not null default 0,
  add column if not exists private_non_nhis_amount numeric(12,2) not null default 0,
  add column if not exists nhis_policy_adjustment_amount numeric(12,2) not null default 0,
  add column if not exists nhis_top_up_policy text,
  add column if not exists patient_payment_method text,
  add column if not exists nhis_claim_id uuid references public.nhis_claims(id) on delete set null;

alter table public.sale_items
  add column if not exists nhis_settlement text,
  add column if not exists nhis_covered_amount numeric(12,2) not null default 0,
  add column if not exists patient_top_up_amount numeric(12,2) not null default 0,
  add column if not exists private_amount numeric(12,2) not null default 0,
  add column if not exists policy_adjustment_amount numeric(12,2) not null default 0;

-- Current sale RPCs are deployment-specific legacy definitions. Patch their
-- existing bodies only when every expected anchor is present, rather than
-- silently replacing a later security hardening change.
do $$
declare
  v_signature regprocedure;
  v_definition text;
  v_name text;
begin
  foreach v_name in array array['public.create_sale_transaction(jsonb)', 'public.branch_sync_create_sale_transaction(text,uuid,jsonb)'] loop
    v_signature := v_name::regprocedure;
    select pg_get_functiondef(v_signature) into v_definition;

    if v_definition not like '%insurance_top_up_method_value TEXT;%'
       or v_definition not like '%insurance_covered_value := COALESCE%'
       or v_definition not like '%insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method%'
       or v_definition not like '%unit_cost_at_sale, line_cost%' then
      raise exception 'Unexpected sale transaction definition for %, refusing split-settlement patch', v_name;
    end if;

    v_definition := replace(v_definition,
      'insurance_top_up_method_value TEXT;',
      E'insurance_top_up_method_value TEXT;\n    nhis_covered_value NUMERIC(12, 2);\n    nhis_top_up_value NUMERIC(12, 2);\n    private_non_nhis_value NUMERIC(12, 2);\n    nhis_policy_adjustment_value NUMERIC(12, 2);\n    nhis_top_up_policy_value TEXT;\n    patient_payment_method_value TEXT;'
    );
    v_definition := replace(v_definition,
      'IF insurance_covered_value < 0 OR insurance_top_up_value < 0 THEN',
      E'nhis_covered_value := COALESCE((sale_payload->>''nhis_covered_amount'')::NUMERIC, 0);\n    nhis_top_up_value := COALESCE((sale_payload->>''nhis_top_up_amount'')::NUMERIC, 0);\n    private_non_nhis_value := COALESCE((sale_payload->>''private_non_nhis_amount'')::NUMERIC, 0);\n    nhis_policy_adjustment_value := COALESCE((sale_payload->>''nhis_policy_adjustment_amount'')::NUMERIC, 0);\n    nhis_top_up_policy_value := LOWER(NULLIF(sale_payload->>''nhis_top_up_policy'', ''''));\n    patient_payment_method_value := LOWER(NULLIF(sale_payload->>''patient_payment_method'', ''''));\n\n    IF insurance_covered_value < 0 OR insurance_top_up_value < 0\n       OR nhis_covered_value < 0 OR nhis_top_up_value < 0\n       OR private_non_nhis_value < 0 OR nhis_policy_adjustment_value < 0 THEN'
    );
    v_definition := replace(v_definition,
      'IF payment_method_value = ''insurance'' THEN',
      E'IF nhis_covered_value > 0 OR nhis_top_up_value > 0 OR private_non_nhis_value > 0 OR nhis_policy_adjustment_value > 0 THEN\n      IF payment_method_value <> ''insurance''\n         OR ABS((nhis_covered_value + nhis_top_up_value + private_non_nhis_value + nhis_policy_adjustment_value) - net_amount) > 0.01 THEN\n        RAISE EXCEPTION ''NHIS settlement buckets must add up to the sale total'';\n      END IF;\n      IF (nhis_top_up_value + private_non_nhis_value) > 0\n         AND patient_payment_method_value NOT IN (''cash'', ''momo'', ''card'') THEN\n        RAISE EXCEPTION ''A patient payment method is required for NHIS top-up or private medicines'';\n      END IF;\n    ELSIF payment_method_value = ''insurance'' THEN'
    );
    v_definition := replace(v_definition,
      'insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method',
      'insurance_covered_amount, insurance_top_up_amount, insurance_top_up_payment_method,\n        nhis_covered_amount, nhis_top_up_amount, private_non_nhis_amount,\n        nhis_policy_adjustment_amount, nhis_top_up_policy, patient_payment_method'
    );
    v_definition := replace(v_definition,
      'insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value',
      'insurance_covered_value, insurance_top_up_value, insurance_top_up_method_value,\n        nhis_covered_value, nhis_top_up_value, private_non_nhis_value,\n        nhis_policy_adjustment_value, nhis_top_up_policy_value, patient_payment_method_value'
    );
    v_definition := replace(v_definition,
      'total_price, unit_cost_at_sale, line_cost',
      'total_price, unit_cost_at_sale, line_cost,\n            nhis_settlement, nhis_covered_amount, patient_top_up_amount, private_amount, policy_adjustment_amount'
    );
    v_definition := replace(v_definition,
      'item_cost, (item_quantity * item_cost)',
      E'item_cost, (item_quantity * item_cost),\n            NULLIF(item->>''nhis_settlement'', ''''),\n            COALESCE((item->>''nhis_covered_amount'')::numeric, 0),\n            COALESCE((item->>''patient_top_up_amount'')::numeric, 0),\n            COALESCE((item->>''private_amount'')::numeric, 0),\n            COALESCE((item->>''policy_adjustment_amount'')::numeric, 0)'
    );

    if v_definition not like '%nhis_policy_adjustment_amount%'
       or v_definition not like '%patient_payment_method_value%'
       or v_definition not like '%nhis_settlement%' then
      raise exception 'Split-settlement replacement failed for %', v_name;
    end if;
    execute v_definition;
  end loop;
end;
$$;

-- Only return money actually collected from the patient. NHIS-covered amounts
-- remain receivables and a policy adjustment is never a cash refund.
do $$
declare v_definition text;
begin
  select pg_get_functiondef('public.refund_sale_transaction(uuid,text)'::regprocedure) into v_definition;
  if v_definition like '%insurance_top_up_payment_method%' then
    v_definition := replace(v_definition,
      E'ELSIF LOWER(COALESCE(v_sale.payment_method, '''')) = ''insurance''\n    AND LOWER(COALESCE(v_sale.insurance_top_up_payment_method, '''')) = ''cash'' THEN\n    v_cash_refund_amount := COALESCE(v_sale.insurance_top_up_amount, 0);',
      E'ELSIF LOWER(COALESCE(v_sale.payment_method, '''')) = ''insurance''\n    AND LOWER(COALESCE(v_sale.patient_payment_method, v_sale.insurance_top_up_payment_method, '''')) = ''cash'' THEN\n    v_cash_refund_amount := CASE\n      WHEN COALESCE(v_sale.nhis_covered_amount, 0) > 0\n        THEN COALESCE(v_sale.nhis_top_up_amount, 0) + COALESCE(v_sale.private_non_nhis_amount, 0)\n      ELSE COALESCE(v_sale.insurance_top_up_amount, 0)\n    END;'
    );
    execute v_definition;
  end if;
end;
$$;

comment on column public.sales.nhis_policy_adjustment_amount is
  'NHIS tariff shortfall not collected from the patient under a not_allowed top-up policy.';

notify pgrst, 'reload schema';
