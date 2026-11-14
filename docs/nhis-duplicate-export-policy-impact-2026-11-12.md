# NHIS duplicate-export policy

Date: 2026-11-12

This change adds an organization-scoped opt-in for exporting NHIS duplicate
claim groups. The default remains blocked. An active organization administrator
or super administrator can enable the policy from the NHIS export dialog; the
change is recorded in `nhis_duplicate_export_policy_audit`. Every export still
runs the existing readiness and non-duplicate blocker checks, and the export
records an audit event when duplicate groups are released by the policy.

The policy is fail-closed when the RPC is unavailable or no policy row exists.
The migration enables RLS and limits policy changes to an active administrator
belonging to the same organization. This is an additive change and does not
remove the existing per-group duplicate review workflow.

Validation for this change includes the duplicate-policy contract test, the
protected production baseline check, migration validation, lint, and the
application build before deployment.
