# Claim-IT compatibility: West Point June baseline (2026-09-21)

This supersedes the May-parity assumptions in `claimit-compatibility-2026-09-20.md`.
Local investigation and correction only. No production system, claim, migration,
storage policy or deployment was touched.

## Definitions

| | Artifact | Role |
| --- | --- | --- |
| A | May 2026 genuine Claim-IT CXF (17 claims) | Structural **reference** only |
| B | West Point June 2026 HealthFlow CXF, accepted by Claim-IT | Proven **compatibility baseline** |
| C | Current exporter on `codex/claimit-local-rollout` | Under test |

Compatibility question: *does current output preserve the proven June behavior unless
there is a deliberate, tested improvement?* Not: *does every value match May?*

## The July file is not West Point

`JUL2026__10AA99EEAE01 [030509386] (HEALTH LIGHT LTD)` (1 claim, 2026-09-20) belongs to
**HEALTH LIGHT LTD, provider 030509386**. It is not a West Point regression artifact.
Its differences from May are shared with June (below) or are facility data.

## Full closed-June evidence (streamed, 650 MB file)

`JUN2026__C4BFE10282AD [030501954] (WESTPOINT CHEMIST)_2026-06-16-2026-06-30.cxf`:
1,227 claims, period 2026-06-16..2026-06-30, envelope generated 2026-08-11 19:58:02,
i.e. after `0800460` (accreditation, 17:23) and `fe672dd` (durations, 18:06). It is the
most likely closed-June file. It could not be proven from the file alone that Claim-IT
imported it; the operator reports the June export succeeded.

| Property | May (A) | June 06-19 (88) | Full June (1,227) | HEALTH LIGHT 'July' |
| --- | --- | --- | --- | --- |
| Signers (`signedOn/By*`) | populated | **null 88/88** | **null 1227/1227** | null |
| `claimType` position | 24 | 75 | **75** | 75 |
| `appVersion.cpuType` | `x64` | absent | **absent** | absent |
| `servVersion` | null | `2023-02-01.250531` | **`2023-02-01.250531`** | same |
| validations / zclaims / prescribersfordays | empty | populated | **populated (1227/1227/1075)** | populated |
| Accreditation `dateGenerated` | 2025-12-29 | 2026-07-29 (export-time) | **2025-12-29** | **2027-08-01** |
| Accreditation schema | May shape | extra 2 columns | **May shape** | May shape |
| `credUsage` rows | 1 | 88 | **1** | 1 |
| Duration | `N.00` DAYS | `N.00` DAYS | `N.00` DAYS | `N.00` DAYS |
| Batch `totalCost` | 5226.17 | 26532.350000000006 | 444192.05999999994 | 251.87 |
| Finances / attachments / summaries | reconcile | reconcile | **reconcile, 0 orphans** | reconcile |

Conclusions: the four differences called out (null signers, claimType at 75, no cpuType,
populated servVersion) are accepted HealthFlow behavior, not compatibility defects.
Post-June changes `0800460` and `fe672dd` are improvements already present in the full
June file. The only defect in the accepted files is float drift in `_meta.totalCost`;
current exact-decimal output is preferable and is kept.

## Is there a genuine regression?

Comparing full June with the current exporter (fixture-driven and classification tests):
**no structural regression exists in the exporter as of `d8285f8` (the pre-branch code).**
The apparent regression was the May-vs-HealthFlow comparison itself. The **branch
`8bd0fe5` introduced regressions relative to June** by making May parity mandatory:
claimType moved, `cpuType` injected, `servVersion` forced null, `addedBy/modifiedBy`
values and envelope signer fields changed, mandatory signer gate, server export gate,
submission trigger. Those are corrected here before they were ever deployed.

## Audit of `8bd0fe5` changes

| Change | Verdict | Reason |
| --- | --- | --- |
| Exact decimal arithmetic (`decimalAmount`, `sumAmounts`, BigInt units) | **KEEP** | Removes proven float drift; formats match June (`251.8700` summaries, 2-decimal costs, numeric meta total). Null/'' inputs keep legacy `\|\| 0` semantics. |
| Accreditation expiry no longer guessed from effective date/2099 | **KEEP** | Export already blocks when expiry is missing; guessing could fabricate credential data. |
| Claim total vs. line total reconciliation before export | **KEEP** | All 1,227 June claims reconcile; no accepted file contains a mismatch, so it rejects no proven-good profile. Data-integrity gate, not a compatibility change. |
| `addedOn/By`, `modifiedOn/By` from claim creator/updater | **REMOVE** | Restored June: export time and configured claims officer. Changed accepted semantics for no evidenced Claim-IT need. |
| Envelope `signedByName/Username/Role` from `exportActor` (null fallback) | **REMOVE** | Restored June (`claimsOfficerName`/`submitterId`/`admin`). |
| Claim field order with `claimType` at 24 (`CLAIM_IT_CLAIM_FIELD_ORDER`) | **MODIFY** | Kept the single canonical ordered serializer (deterministic, no reliance on object order) but rebased on the June order: `claimType` last (75). |
| `_dbstruct` `claimType` column position | **REMOVE** | Restored June position (last in `claims`). |
| `canonicalizeBundle` / `fieldOrder.js` (all table orders from May) | **MODIFY** | Kept; orders now derive from `west-point-june-contract.json` (identical to May except claimType and the two accreditation columns already fixed). |
| `cpuType: x64` injection | **REMOVE** | Absent in every accepted HealthFlow export. |
| `servVersion` null for PVT-PHC-CE without services | **REMOVE** | June populated it. Restored `payload.serviceVersion \|\| default`. |
| Mandatory signer check (`assertClaimSignature`, throws) | **MODIFY** | Replaced by non-throwing `classifyClaimSignature`; `LEGACY_UNSIGNED_CLAIM` is a warning. Genuine stored signing evidence is still written to the claim row; never invented. |
| Server `claimit_export_claims` gate (signature, readiness, re-export reason) | **MODIFY** | Forward migration `20260921130000` turns findings into `claimit_warnings`; authorization/batch-shape errors still raise. Client only merges signing evidence onto its own claim rows and never blocks. |
| Server override of client provider config (`claimit_config`) | **REMOVE** | Client settings drove the accepted June output; overriding them is an unproven change to provider identifiers/accreditation. |
| `record_nhis_cxf_export_atomic` audit | **KEEP (non-blocking)** | Audit trail retained; failure now reports `EXPORT_AUDIT_NOT_RECORDED` without withholding a generated file. |
| Submission/settlement trigger requiring a signature | **MODIFY** | Now audit-only. Blocking `submitted`/`paid` for legacy claims would break normal workflows that June allowed. |
| `sign_nhis_claim` + immutable signature tables | **KEEP** | Opt-in HealthFlow audit feature; identity derived from the authenticated user; review-only accreditation findings no longer prevent signing. |
| Legacy audit / total repair RPCs | **KEEP / MODIFY** | Repair logic unchanged (never fabricates). Audit separates `issues` (need review) from `warnings` (`LEGACY_UNSIGNED_CLAIM`, `ACCREDITATION_DATE_REVIEW_REQUIRED`, legacy export history). Only real issues create remediation flags. |
| Remediation UI | **MODIFY** | Says signing is optional; shows warnings; warnings do not count as "requires review". |
| Whole-app typecheck, dev tooling, tests | **KEEP** | Independent of the compatibility decision. |
| `20260811173000` replay-safety edit | **KEEP** | Idempotent guard only; no behavior change on applied databases. |

## Health Light accreditation finding

Stored generated date `2027-08-01` equals the expiry `2027-08-01`; effective `2025-10-01`.
Trace: `dateGenerated` is read only from `accreditationDateGenerated` /
`accreditationGeneratedDate` / `accreditation_date_generated`. No code path copies the
expiry into it (Settings, Offline Sync, tier-access, exporter checked). The only seeded
value is West Point's (`2025-12-29`, migration `20260811173000`); there is no Health
Light seed or default. So the value is stored data (most consistent with manual entry in
the "Accreditation Generated Date" field). The offline branch database has no
`accreditation_date_generated` column at all (`local-branch-server/src/db.js`), which is
worth confirming for any offline branch.

Not repaired and not guessed. Flag: **`ACCREDITATION_DATE_REVIEW_REQUIRED`** (warning,
never blocks export). Whether Claim-IT rejects a future-dated `dateGenerated` is
**unproven**: accepted West Point files only had dates on or before their export date.
Correct the value from the original NHIA accreditation record.

## Tools and tests added

- `scripts/lib/cxf-stream-reader.mjs`: bounded-memory streaming PHP/CXF reader (large
  strings become length-only placeholders). Reads the 650 MB file in ~5 s / ~800 MB RSS.
- `scripts/lib/cxf-profile.mjs`, `scripts/profile-cxf.mjs`, `scripts/extract-cxf-contract.mjs`:
  sanitized profiles/contracts (no patient values). `scripts/compare-cxf.mjs` streams large files.
- `scripts/lib/cxf-classify.mjs`: REQUIRED COMPATIBILITY / HEALTHFLOW-ACCEPTED VARIATION /
  FACILITY-SPECIFIC DATA / SUSPICIOUS DATA / ACTUAL REGRESSION.
- `src/claimit/west-point-june-contract.json`, regenerated `may-reference-contract.json`.
- `src/claimit/juneBaseline.test.js` (incl. opt-in real-file tests:
  `CLAIMIT_JUNE_CXF`, `CLAIMIT_JUNE_FULL_CXF`), updated `compatibility.test.js`,
  `lifecycleSql.test.js`, `claimitLifecycleService.test.js`, remediation UI test.
- Migration `20260921130000_claimit_legacy_claims_non_blocking.sql` (local, not deployed).

## Staging recommendation

1. Apply both earlier Claim-IT migrations and `20260921130000` to staging only (never
   production) and rerun the SQL/RLS checks.
2. Regenerate a small West Point June-shaped export from staging data and run
   `node scripts/compare-cxf.mjs <accepted-june.cxf> <regenerated.cxf>` plus the
   classification test with `CLAIMIT_JUNE_CXF`; expect zero ACTUAL REGRESSION.
3. Import the regenerated file into Claim-IT and record acceptance. This is the one check
   that cannot be simulated locally.
4. Separately, confirm the Health Light accreditation dates against the source record.
