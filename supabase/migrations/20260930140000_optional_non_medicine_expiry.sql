-- Medicines retain required expiry dates; non-medicine inventory may not expire.
alter table public.drugs alter column expiry_date drop not null;
alter table public.drugs add constraint drugs_medicine_expiry_required
  check (expiry_date is not null or coalesce(category, '') in ('consumable', 'medical_equipment', 'non_medical', 'supplement', 'cosmetic'));
