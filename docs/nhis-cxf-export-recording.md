# NHIS CXF export: RPC 500s and reliable recording

## What failed (3,093-claim export)
The CXF file was generated correctly. Two server calls returned HTTP 500 around it:

| RPC | When | Cause |
|---|---|---|
| `claimit_export_claims` | start (signing evidence) | Statement timeout (`authenticated` = 8 s, SQLSTATE 57014, shown as HTTP 500) |
| `record_nhis_cxf_export_atomic` | after the file existed | Same timeout; it recomputes the whole snapshot for all 3,093 claims inside one statement |

Both build `claimit_snapshot()` = `to_jsonb(nhis_claims)`, and `nhis_claims.claimit_attachment_base64` holds the
prescription PDF as base64 (avg ~320 KB, max ~1.1 MB), so a snapshot averages ~340 KB. `claimit_export_claims`
hashes it three times per claim, appends to a growing jsonb (quadratic) and returns every snapshot (~170 MB per
500 claims). Measured on production: 10 claims 0.18 s, 50 claims 0.97 s, 100 claims 3.5 s.

Nothing had ever been recorded for that export: the last `nhis_cxf_events` row is from 2026-09-21. The client
swallowed both errors (it treats them as non-blocking) and `Nhis.jsx` never passed `onExportWarnings`, so a failed
record was invisible to the user.

## Fix
Migration `20260925130000_nhis_cxf_export_recording_reliability.sql` (additive; no signature or return type changes):
- `claimit_export_signing_evidence()` returns the same evidence (signer, warnings, fingerprints) without the snapshot.
  ~7 ms per claim (500 claims 3.7 s vs. timeout, 266 KB response vs. ~170 MB). Fingerprints are byte-identical to the legacy RPC.
- Idempotent recording: unique index `(claim_id, event_type, artifact_sha256)`; `record_nhis_cxf_export()` skips a claim
  already recorded for that artifact, so retries never duplicate events or flip a first export into a re-export.
- `claimit_export_claims()` itself is unchanged. Legacy unsigned claims stay non-blocking.

Client (`claimitLifecycleService.js`, `nhisService.js`, `Nhis.jsx`):
- Evidence and recording run in chunks of 250 claims (each call fits well inside 8 s). Legacy evidence RPC is used only
  if the new one is not deployed yet.
- States: FILE_GENERATED -> RECORDED, or RECORDING_FAILED (partial success). A failed record is reported with a banner
  ("CXF generated, export record not fully saved") and a **Retry recording** button that re-sends only the failed chunks
  with the same artifact hash. It never regenerates the file or downloads attachments again.
- Structured, PHI-free logging: `[CLAIM-it export RPC failed]` with rpc, SQLSTATE, message, details, hint, HTTP status,
  export reference, facility id, claim count, chunk numbers.

## Deployment order
1. Apply the migration (SQL editor). The old client keeps working (legacy path), but still cannot record 3,000+ claims.
2. Deploy the frontend.
Rollback: revert the frontend; the migration is additive (the unique index and new functions can stay).

## Drift found
`claimit_*`, `record_nhis_cxf_export*` and `nhis_cxf_events` exist in production, but their migrations
(`20260920120000`, `20260920130000`, `20260921130000`, ...) are only on branch `codex/claimit-local-rollout`, not on `main`.
The tests use `src/services/fixtures/claimitProductionRpcBaseline.sql`, the production definitions captured 2026-09-25.
