# Reorder Centre — Phase 4: multi-branch transfer advice

Status: implemented on branch `feature/branch-transfer-advice` (on top of Phases 1–3 as shipped in `af5b7e9`). **Not deployed.**

Advisory only. Nothing moves automatically. A transfer happens only when a person presses
"Transfer stock", through the existing, audited `transfer_drug_to_branch()`.

## What changed

- **The Reorder Centre now has a branch context.** Before this, a user with no branch on their
  profile (an organization-level admin) got every branch's rows mixed into one list with no branch
  label. It now shows one branch at a time (default: the main branch), with a selector. A user tied to
  a branch is fixed to theirs. A single-branch pharmacy has no selector and loads exactly as before.
- **Transfer advice.** For each medicine that needs restocking, the page shows "Kumasi has 70 spare —
  transfer instead" next to the suggested quantity. It opens a confirmation showing each source
  (branch, batch, expiry, spare), a quantity defaulting to what is needed (capped at the spare), and an
  optional note. Buying the rest still works as usual.
- **The database function** `get_branch_transfer_options(branch_id, drug_ids)`
  (`20260923120000_branch_transfer_options.sql`) is read-only.

## Rules

- **Spare** = a source row's quantity minus that row's own reorder level, so a transfer never pushes the
  source branch into low stock. Stock at or below its threshold is never offered.
- Never offered: expired stock, inactive medicines, inactive branches, other organizations, the same branch.
- **Same medicine** = same name, ignoring case and spacing (the existing transfer matches destination rows on
  name + batch). Different batches of it are listed separately.
- **Visibility.** Branch-bound staff get no options (they never see other branches' stock anywhere
  else in the app, and this does not change that). Only organization-level staff with purchasing access see
  the advice, and only staff who can adjust stock get the transfer button; others see the advice as text.
- Transfers need internet and are never queued offline (existing behaviour).

## Known limits

- **Advanced analytics were not built.** The brief named them without a concrete definition; I did not
  invent metrics. Say which numbers you want and they can follow.
- Same-medicine matching is by name, not a shared catalogue id, so a renamed medicine in one branch will not match.
- The existing transfer overwrites the destination row's price, cost price and reorder level with the
  source's when the destination row already exists. That is existing behaviour and unchanged here.
- No approval or request workflow: whoever can adjust stock can pull stock from another branch once
  they confirm. The source branch is not notified beyond the stock movement records.
- The suggested purchase quantity is not reduced automatically when advice exists; the person decides.

## Applying it

Run `supabase/migrations/20260923120000_branch_transfer_options.sql` (needs the Phase 2 migration, for
`user_can_manage_purchases()`). Then deploy the app. Until the migration is applied the Reorder Centre still
works and simply shows no transfer advice.
