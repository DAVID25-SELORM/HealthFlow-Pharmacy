BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_branch_nhis_claim_medicine_drug_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_organization_id UUID;
  v_resolved_drug_id UUID;
BEGIN
  IF NEW.nhis_drug_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id
  INTO v_organization_id
  FROM public.nhis_claims
  WHERE id = NEW.claim_id;

  IF EXISTS (
    SELECT 1
    FROM public.nhis_drugs
    WHERE id = NEW.nhis_drug_id
      AND organization_id = v_organization_id
  ) THEN
    RETURN NEW;
  END IF;

  IF v_organization_id IS NOT NULL AND NULLIF(BTRIM(NEW.drug_code), '') IS NOT NULL THEN
    SELECT id
    INTO v_resolved_drug_id
    FROM public.nhis_drugs
    WHERE organization_id = v_organization_id
      AND UPPER(BTRIM(code)) = UPPER(BTRIM(NEW.drug_code))
    ORDER BY updated_at DESC, id
    LIMIT 1;
  END IF;

  NEW.nhis_drug_id := v_resolved_drug_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS resolve_branch_nhis_claim_medicine_drug_reference
  ON public.nhis_claim_medicines;

CREATE TRIGGER resolve_branch_nhis_claim_medicine_drug_reference
BEFORE INSERT OR UPDATE OF nhis_drug_id, drug_code, claim_id
ON public.nhis_claim_medicines
FOR EACH ROW
EXECUTE FUNCTION public.resolve_branch_nhis_claim_medicine_drug_reference();

COMMIT;
