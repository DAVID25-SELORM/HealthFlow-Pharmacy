-- Reorder Centre phase 1: an optional desired stock level per medicine, distinct
-- from reorder_level (the threshold that triggers attention). Nullable and
-- additive only — nothing is guessed or mass-written for existing drugs.
-- Calculations that need a target fall back to reorder_level for that one
-- calculation, and never write that fallback back to the row.
begin;

alter table public.drugs
  add column if not exists target_stock_level numeric;

alter table public.drugs
  drop constraint if exists drugs_target_stock_level_non_negative;
alter table public.drugs
  add constraint drugs_target_stock_level_non_negative
  check (target_stock_level is null or target_stock_level >= 0);

alter table public.drugs
  drop constraint if exists drugs_target_at_least_reorder_level;
alter table public.drugs
  add constraint drugs_target_at_least_reorder_level
  check (target_stock_level is null or target_stock_level >= coalesce(reorder_level, 0));

comment on column public.drugs.target_stock_level is
  'Desired stock level after replenishment. Null = not set; the Reorder Centre falls back to reorder_level for that one calculation only, and never writes that fallback back to this column.';

notify pgrst, 'reload schema';

commit;
