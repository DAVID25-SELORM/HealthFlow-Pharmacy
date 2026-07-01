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

## Data recovery

- Added administrator Recycle Bin for inventory items and NHIS claims.
- Added restore and permanent-delete controls.
- Added defense-in-depth checks that reject recovery and direct-serving
  mutations from disabled staff accounts.

## Offline and facility server

- Prepared signed Local Branch Server release 1.4.2 containing the current
  offline bundle and the complete seven-day update set.
- Added facility-wide offline PIN authentication using salted scrypt hashes.
- Added lockout, rate limiting, audit logs, and admin enable/reset/revoke.
- Added HTTPS/TLS startup detection and local-only fallback.
- Added automated Windows installation and workstation trust enrollment.

## Performance and deployment

- Added PostgreSQL accounting sales aggregation and supporting indexes.
- Refreshed production and offline bundles.
- Release verification: lint, production build, offline build, and 410 automated
  tests passed.
