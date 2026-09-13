# Separate readiness and atomic settlement

User decision: retain Serving Readiness versus stricter Export Readiness. Do not apply migrations or deploy. Subsequent user instruction authorizes commit and push.

Changes:
- assessNhisReadinessContracts reuses existing MCA medicine blockers and explicit CCC/duration checks for serving. Export runs finalSubmission validation and includes every serving blocker. It does not turn export-only attachment or administrative requirements into serving requirements. Existing readiness call sites are retained; this is not a claim that every backend business rule has been consolidated.
- Reopened claim form shows every remaining serving blocker, export blocker and warning at the top. The lists recalculate on form edits; removed six-alert truncation from the existing summary. This covers the local synchronous readiness checks; remote overlap/eligibility checks still run through their existing workflows.
- mark_nhis_claim_paid is a SECURITY INVOKER RPC: existing RLS remains active. It locks the claim, calculates unpaid balance, updates status and inserts payment in one transaction. Payment/status failures roll back together. Retrying settlement through this RPC sees the prior payment and does not duplicate it. Actor comes from auth.uid(), organization/branch from persisted claim. Paid-status service uses only this RPC and never falls back to status-only offline saving. Thus marking paid requires cloud connectivity and the unapplied RPC migration.
- Revised unapplied duration migration distinguishes actual state/serving transitions from unchanged header updates and in-place legacy corrections. A valid correction of one medicine is allowed while another legacy duration remains invalid. Clearing a valid duration and further serving/submission remain blocked. CCC guards likewise permit unchanged CCC during metadata/direction repair while still checking changes/progression. No historical values rewritten.

Historical correction limitations:
The existing audited duration-repair RPC can now repair one or multiple durations and update the parent version without unrelated invalid durations or unchanged missing CCC blocking it. Full delete/recreate replacement still rejects newly inserted invalid lines; use in-place audited duration repair first. This does not authorize inventing missing values. All remaining issues are visible in the correction form. Separate service-level full-save validations remain strict, so partial full-form corrections are not promised.

Validation:
241 service/UI tests passed; 3 SQL tests passed using PGlite. SQL tests cover payment failure rollback, successful settlement, repeated settlement without duplicate payment, incomplete Draft, invalid progression, preserved clinical duration, invalid replacement, and individual historical repairs. Lint passed. Build and baseline/migration verification recorded in final response. SQL tests use minimal fixture schemas and do not certify production RLS/branch policies or concurrent writes through OTHER payment paths. Full production migration compatibility remains a deployment gate.

No migration applied. Commit and push subsequently authorized; no deployment. The broader integrity audit remains open: complete rule/path/state backend parity, production authorization tests, structured blockers across every path, and all payment entry points require further work.


## Applied migration clarification
The user confirmed applying the original 46-line duration migration before its later edits. The repository now restores that original migration from e8d0023. Incremental correction changes are moved into 20260913180000_allow_incremental_nhis_integrity_corrections.sql, which replaces only function bodies and preserves existing triggers. Apply the new follow-up, not the original migration again. This follow-up has not been applied by the assistant. The payment migration is separate; its applied status is not inferred from this confirmation.

User subsequently reported "Success. No rows returned" after selecting the 20260913180000 follow-up and authorized commit/push. This records user-reported application success, not an independent live-schema verification. The original-to-follow-up upgrade and repeat-application tests passed (2 tests); migration and baseline checks passed. Payment migration application remains unconfirmed.
