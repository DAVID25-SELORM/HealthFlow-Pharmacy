# HealthFlow Release Notes — 1 July 2026

## Claims and NHIS

- Claims Officers can save details, send to dispensary, or serve directly.
- Incomplete intakes can be dispatched and completed later on the same claim.
- Pharmacy claims require a prescription attachment before final submission.
- Direct serving bypasses MCA, marks all entered quantities served, and does not
  depend on or modify inventory.
- Database safeguards prevent MCA changes to directly served claims.
- Date-of-birth entry no longer resets to a default date.
- Long NHIS lists include bottom pagination controls.
- Patient history now loads medicine lines on demand for sales, general
  insurance claims, and all matching NHIS visits, including prescribed/served
  quantities and serving status.

## Data recovery

- Added administrator Recycle Bin for inventory items and NHIS claims.
- Added restore and permanent-delete controls.
- Added defense-in-depth checks that reject recovery and direct-serving
  mutations from disabled staff accounts.

## Offline and facility server

- Prepared signed Local Branch Server release 1.4.3 containing the current
  offline bundle, the complete seven-day update set, and patient medication
  history.
- Added facility-wide offline PIN authentication using salted scrypt hashes.
- Added lockout, rate limiting, audit logs, and admin enable/reset/revoke.
- Added HTTPS/TLS startup detection and local-only fallback.
- Added automated Windows installation and workstation trust enrollment.

## Performance and deployment

- Added PostgreSQL accounting sales aggregation and supporting indexes.
- Refreshed production and offline bundles.
- Release verification: lint, production build, offline build, and 410 automated
  tests passed.

## Consequential-action review safeguards

- Added a consistent final preview before high-impact clinical, financial,
  inventory, purchase, refund, and fulfilment actions.
- Preview messages identify the affected record and show relevant amounts,
  parties, statuses, reasons, or quantities before execution.
- NHIS readiness, CC/CCC handling, tariff logic, and stock behaviour are
  unchanged; the new layer only asks the user to verify an already validated
  action.
- Routine draft and detail saves remain prompt-free.

## Complete patient pagination

- Patient Records now builds one deduplicated index from registered patients
  and NHIS claim-only patients before applying search or pagination.
- Page totals include NHIS-only patients, and the same person is merged using
  patient ID, NHIS member number, HIN, folder/name, or name/date of birth.
- Local Branch Server reads no longer stop at 5,000 patient or NHIS records.
