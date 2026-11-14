# Country-code Ghana Card numbers in the edge functions

Date: 2026-11-14

A Ghana Card issued to a foreign national carries the holder's three-letter
country code instead of `GHA` (for example `KEN-729238252-0`). The web app and
the local branch server already accept these numbers (PR #20). The three
server-side checks below still required `GHA-`, so a CC code or an online
member lookup for such a card was rejected before reaching NHIA.

## What changes

- New `supabase/functions/_shared/ghanaCardNumber.ts`: the ISO 3166-1 alpha-3
  prefix list (249 codes, the same list as the web app and branch server) and
  two checks: canonical (`CCC-#########-#`, upper case) and lenient (tolerates
  case and surrounding spaces).
- `supabase/functions/tier-access/index.ts` (protected file): the local
  `isGhanaCardNumber` regex `^GHA-\d{9}-\d$` is replaced by the shared lenient
  check. Card-type detection (`GHANACARD` vs `NHISCARD`) is the only use.
- `supabase/functions/_shared/cccProvider.ts`: card-type inference and the
  format check use the shared canonical check.
- `supabase/functions/_shared/nehfamsAdapter.ts`: the attendance request check
  uses the shared canonical check.
- `src/pages/Nhis.jsx`: one warning message now says foreign nationals use
  their country code instead of `GHA`.

## What does not change

- 8-digit NHIS numbers and `GHA-` cards behave exactly as before. A mistyped
  prefix (`GAH`, `KXN`) and a wrong digit count are still rejected.
- No database, migration, claim export or HIN rule changes. A Ghana
  Card-linked claim still needs the numeric NHIS number in the HIN field
  before final export.
- Card type sent to NHIA stays `GHANACARD`.

## Open risk

Whether NHIA's CCC / NeHFAMS services accept a country-code card number is not
confirmed. This change only stops us rejecting the number locally; NHIA will
accept or refuse it. Confirm with one real foreign national card in the NeHFAMS
test environment before relying on it in production.

## Verification

`src/services/ghanaCardNumberEdge.test.js` covers the shared checks, the
three-way prefix list parity (edge, web, branch server), NeHFAMS request
preparation, and CCC request validation. The protected production baseline
manifest is updated for `tier-access/index.ts`.

## Rollback

Revert the commit and redeploy `tier-access`. No data is written or migrated.
