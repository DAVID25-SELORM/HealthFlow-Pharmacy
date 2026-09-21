# Claim-IT CXF export: production application release (2026-09-21)

Application code only. **No database migration, storage change or historical claim repair is part of
this release.** Based on `main` (`fec0a40`) plus the CXF exporter and its dependencies from the review
branch `codex/claimit-local-rollout` (`9d08d6f`); the UI panels, migrations and branch-server changes on
that branch are intentionally excluded and remain separate.

## Behavior
- Claim/table field order, `_dbstruct` schema and `appVersion` follow the genuine May Claim-IT export:
  `claimType` at position 24, `cpuType: x64`, `servVersion` null for medicine-only claims.
- **Validation, validation z-claim and prescriber-for-day sections stay populated** (May's empty tables are
  not a reason to drop them; the relational/bridge payload depends on them). Restored after the May
  alignment had emptied them.
- Signer fields: a VALID claim in a genuine Claim-IT export always carries its signer. A complete
  signature already stored on the claim is used as-is; otherwise the authenticated exporting user
  (name and email from their own signed-in session, role `admin` as in the accepted envelope) and the
  export time. Stored and exporter values are never mixed. With no signed-in identity the fields stay
  null and the export reports `LEGACY_UNSIGNED_CLAIM`; nothing is invented and nothing is blocked.
  Using the exporter is reported as `SIGNER_ASSIGNED_FROM_EXPORT_USER`.
- Exact decimal totals (no float drift); explicit `dateGenerated` never derived from effective/expiry;
  human-readable message when the accreditation generated date is missing.
- Signing evidence and export audit use the existing server RPCs best-effort and never block an export.

## Not verified
No Claim-IT import of a file from this build has been performed. May remains the only verified structural
reference; the June files are not proven accepted artifacts.
