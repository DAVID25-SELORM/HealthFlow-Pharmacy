# POS NHIS coverage: tariff-missing NHIS prices and unresolved lines

## Root cause
The POS settlement (`src/utils/nhisSplitSettlement.js`) was already line-level: a line is NHIS-covered only when
the cart line carries an NHIS code **and** an NHIS tariff (> 0). NHIA Claim mode does not cover everything.

The reason a genuine NHIS medicine ended up "covered GHS 0.00 / private GHS x" was upstream: the
`tier-access` edge function decided whether an NHIS price was "blank" with `normalizeText(value) === ''`.
`normalizeText` returns `''` for anything that is not a string, and the browser sends `nhisPrice` as a JSON
number, so **every numeric NHIS price was saved as NULL** on create, update and bulk import. The POS then
built the cart line with `nhisPrice = null` (`getNhisCatalogPrice` needs a price > 0), so the line settled as
private. This is the same class of bug as the Target stock level issue (`3c88c04`).

## Changes
- `supabase/functions/tier-access/index.ts`: `isBlankInput()` (undefined / null / whitespace-only string) replaces
  the `normalizeText(...) === ''` checks for NHIS price on create, update and bulk import. Numbers are kept.
- `src/utils/nhisSplitSettlement.js`: each line gets `coverage` = FULLY_COVERED / PARTIALLY_COVERED /
  NOT_COVERED / UNRESOLVED. UNRESOLVED = listed in the NHIS catalogue but no usable tariff. Result exposes
  `unresolvedLines`. Amounts are unchanged (cent-rounded, capped at the line's net value, never negative).
- `src/pages/Sales.jsx`: the cart line carries `nhisListed`; NHIA claim mode shows per-line coverage and a
  "tariff missing" alert, and refuses to complete the sale while any line is unresolved (a guessed NHIS amount
  is never submitted, and a listed medicine is never silently billed as private).

## Not changed
Claim-IT serializer, claim calculations, tariffs, statuses, migrations, CCC/CC-code rules, sale persistence.

## Data repair (NOT applied)
Existing NHIS-listed rows whose price was wiped need `nhis_price` restored from the NHIS catalogue by
`nhis_code`. List them with:
`select id, name, nhis_code, price from drugs where is_nhis_listed and (nhis_price is null or nhis_price <= 0);`
Re-running the catalogue sync (or re-saving through the fixed function) restores them. Deploying the fixed
`tier-access` is required first, otherwise a re-save wipes the price again.
