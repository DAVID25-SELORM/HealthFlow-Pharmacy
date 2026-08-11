# Drug Utilization Report impact assessment — 2026-08-10

## Scope

This change extends the existing Reports → Drug Utilization implementation. It does not add a second report or change NHIS claim creation, pricing, tariffs, scrubbing, CLAIM-it generation, inventory mutation, offline synchronization, or authentication.

## Security design

Every cloud report endpoint resolves its effective branch as `requesterProfile.branch_id || requestedBranchId`. A branch-assigned user therefore cannot widen scope with an empty branch or substitute another branch ID. Organisation-wide users may select an organisation-owned branch or all branches. Parent sales and NHIS claims remain constrained by the authenticated organisation before child line records are attached.

The same resolved scope is applied to branch-owned report records, including sales, claims, drugs, NHIS pagination and aggregates, medicine search, purchases, inventory, and export batches. Patients are organization-owned in the production schema and have no `branch_id`; their lookup remains organization-scoped and only enriches already branch-scoped report records. Chemical Shop catalogue filtering remains in place.

## Data and inclusion rules

- POS utilization is sourced from completed sales and their sale items.
- NHIS utilization is sourced from persisted NHIS claims and persisted medicine lines; quantity follows the existing dispensed/served quantity precedence.
- Purchases, receipts, quotations, and unsaved UI rows are not dispensing lines.
- POS and NHIS lines retain distinct source labels and are summed once.
- Product names/IDs remain distinct; strengths are not deliberately merged.

## User-visible changes

- Patient filter (name and available member/folder identifiers).
- Independent Prescriber and Served By filters.
- Served By and strength/form drill-down columns.
- POS and NHIS quantity split in the summary.
- Friendly branch names where the server relationship is available.
- Local-time Today, week, month, quarter, year, previous-period, and Custom presets.
- Explicit matching/visible record count and “Export All CSV” wording.

## Characterization

`src/pages/Reports.test.jsx` covers filter separation, period presets, friendly names, existing role behavior, NHIS/POS combination, and drill-down behavior. `src/contracts/reportBranchSecurity.contract.test.js` protects authenticated branch precedence, organisation predicates, independent server filters, completed-POS inclusion, and the absence of invalid patient branch predicates. `supabase/functions/tier-access/index.test.js` also characterizes compatibility with the production patients schema. Existing tier-access characterization, contract tests, lint, and production build remain required gates.

Large organizations are handled with bounded PostgREST filters. NHIS claim, medicine/service line, serving-user, and search hydration lookups chunk UUID lists so report generation does not exceed gateway URL limits. Edge Function error objects are normalized into readable messages rather than `[object Object]`.

## Rollback

Revert the report UI, report tests, report security contract, this document, and the tier-access report-query changes together. No migration or data rollback is required.
