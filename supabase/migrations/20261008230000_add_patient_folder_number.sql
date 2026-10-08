-- Patient forms persist folder numbers on the patient record. Older databases
-- only have this field on NHIS claims, so patient creates/updates fail.
begin;
alter table public.patients add column if not exists folder_no text;
comment on column public.patients.folder_no is 'Patient folder number maintained with patient contact details.';
notify pgrst, 'reload schema';
commit;
