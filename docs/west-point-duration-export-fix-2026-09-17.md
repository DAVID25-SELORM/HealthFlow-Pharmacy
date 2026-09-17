# West Point July duration export fix

## Root cause and scope

`buildNhisDurationRepairReview` passed `medicine.duration` to
`analyzeNhisDurationForRepair`, which reused the strict clinical-entry validator.
That rejected bare numbers and uppercase units and produced the generic
"Origin is not established" message without checking provenance.

The user has now established the historical NHIS domain rule: positive bare
integers mean days for export. A dedicated export-only resolver applies that
rule, trims whitespace, recognizes day/week/month units case-insensitively,
and retains the existing 7-day week and 30-day month conversions. It rejects
missing, malformed, nonpositive, fractional and unsafe-integer results.

The review and CXF duration serialization share the resolver. Numeric day values
retain the established CLAIM-it decimal-string wire representation (`90.00`)
with unit `DAYS`. No clinical values are overwritten. No scope/status/counting
logic, database migration, or historical-record inference was introduced.
Manual correction validation remains strict despite the broader export resolver.

## Expected effect on supplied July data

3,100 claims / 7,973 medicine lines remain in scope. Of 521 previously flagged
lines, 516 bare integers and two explicit-unit case variants become exportable.
Expected result: 7,970 exportable, three unresolved. This is a local validation
against supplied evidence, not a production rescan or CLAIM-it acceptance result.

Remaining NULL durations:

- NHIS-002823 / SODCHLIN3
- NHIS-003067 / SODCHLIN3
- NHIS-003067 / DESOCHIN2

All-or-nothing export remains blocked until genuine durations are supplied for
these records and any other existing export requirements pass.

## Resolve button

The button invokes `handleApplyDurationRepairs`. Incomplete/invalid inputs show
an error and focus the manual rows without writing. Once all listed corrections
are valid, it invokes the audited repair RPC, clears cached readiness and rescans
before resuming export. This is a clinical correction action, not an automatic
normalization action. Accepted historical export values do not enter repairRows.

## Files and validation

- `src/services/nhisService.js`: shared export resolver and separate strict repair gate.
- `src/services/nhisService.test.js`: numeric/unit/invalid-value cases, nonmutation,
  July aggregate fixture, and updated West Point CXF regression.
- `config/production-baseline.json`: updated local protected fingerprint.

The isolated release passed 261 tests across NHIS service, duration-integrity SQL and CCC contracts.
Targeted lint and protected baseline checks passed. The July fixture uses the
reported category totals; it is synthetic, not a copy of clinical records.
No database or clinical records were changed. Pending workload changes already
in these files are excluded from the release. Deployment status is reported separately.
