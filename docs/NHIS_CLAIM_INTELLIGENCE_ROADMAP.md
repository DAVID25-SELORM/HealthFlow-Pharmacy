# NHIS Claim Intelligence Roadmap

Date: 2026-07-19
Scope: Roadmap only. No production workflow or NHIS logic changes.

## Protected Areas

The following areas must not be changed by this roadmap without a separate explicit approval and production test plan:

- CCC / CC code generation and validation behavior
- NHIS claim pricing
- NHIS export file format
- NHIS duplicate detection logic
- NHIS direct submission behavior
- Existing claim save, serve, dispensary, reopen, and correction workflow logic

## Why This Exists

Recent field feedback showed a claim with a malaria diagnosis and a typhoid laboratory test without a clinical warning. That is not necessarily a claim-processing bug. It is a gap in the advisory claim scrubber layer: the current scrubber is stronger at completeness checks than at clinical coherence checks.

The next evolution should be a clinical claim intelligence layer that explains possible diagnosis, medicine, laboratory, procedure, age, gender, admission, and referral mismatches before export or submission.

## Intended Product Behavior

The claim intelligence layer should help users correct documentation and billing issues before submission. It should not silently change claims.

Recommended workflow:

1. User enters or edits claim details.
2. User runs claim scrubber or export pre-check.
3. System shows advisory findings grouped by severity.
4. User corrects the claim or records an override reason where allowed.
5. Export or submission proceeds only when current production blocking rules allow it.

## Severity Model

Use the existing scrubber severity concept, but keep future clinical rules advisory until approved.

- Error: blocks final submission only when the rule is explicitly approved as blocking.
- Warning: allows continuation but asks the user to review or explain.
- Info: educational suggestion only.

## Phase 1: Documentation And Rule Catalog Design

No production behavior change.

Deliverables:

- Define rule catalog structure.
- Define issue message format.
- Define audit fields for future override reasons.
- Define hospital and insurer-side rule ownership.

Suggested rule catalog fields:

```text
rule_id
rule_type
severity
diagnosis_terms
expected_labs
expected_medicines
expected_procedures
age_constraints
gender_constraints
message_title
message_body
recommendation
blocking_enabled
```

## Phase 2: Non-Blocking Advisory Display

No CCC, pricing, export format, duplicate logic, or NHIS submission behavior changes.

The UI can show advisory clinical findings without blocking users:

- Diagnosis to laboratory review
- Diagnosis to medicine review
- Diagnosis to procedure review
- Age and gender review
- Missing primary diagnosis review
- Duplicate diagnosis/medicine/procedure review

Example advisory:

```text
Diagnosis-Lab Review

Diagnosis: Plasmodium falciparum malaria
Investigation: Typhoid test

Typhoid testing is usually associated with typhoid or suspected enteric fever.
If typhoid is clinically suspected, add the supporting diagnosis. Otherwise review the selected investigation.
```

## Phase 3: Admin Rule Management

No automatic blocking by default.

Super Admin should be able to:

- Enable or disable advisory rules.
- Decide whether a rule is Info, Warning, or Error.
- Require override reasons for warnings.
- Review rule performance and false positives.

## Phase 4: Hospital-Side Real-Time Scrubbing

This phase requires careful approval because it affects claim entry experience.

Possible checks:

- Diagnosis versus laboratory investigation
- Diagnosis versus medicine
- Diagnosis versus procedure or tariff
- Age and gender consistency
- Admission and referral consistency
- Quantity, dose, and duration warnings

Initial recommendation: warning-only mode for at least one production cycle.

## Phase 5: Hospital Pre-Export Scrubbing

This phase should integrate with the existing export readiness view without changing export file structure.

Goal:

- Show all clinical and completeness issues before export.
- Preserve existing duplicate and attachment behavior.
- Do not alter generated CLAIM-it/CXF/XML/CSV/JSON output.

## Phase 6: Insurer-Side Scrubbing

HealthConnect insurer-side scrubbing should re-check claims independently after receipt.

Possible checks:

- Diagnosis-treatment mismatch
- Duplicate claims
- Excessive quantities
- Frequency limits
- Waiting periods
- Benefit exclusions
- Provider contract rules
- Historical utilization patterns

## Implementation Guardrails

- Do not hard-code broad clinical blocks directly into NHIS claim save/export functions.
- Keep rules data-driven where possible.
- Keep new clinical findings separate from current duplicate detection.
- Do not recalculate claim prices from clinical findings.
- Do not modify CCC generation or validation paths.
- Do not alter CLAIM-it export format.
- Add unit tests for every rule before enabling it.
- Start with warning-only mode for clinical coherence rules.

## Suggested First Rule Set

Start small, measurable, and Ghana/NHIS workflow-aware.

1. Malaria diagnosis without malaria RDT, microscopy, ACT, quinine, or artesunate.
2. Malaria diagnosis with typhoid test but no typhoid or suspected enteric fever diagnosis.
3. Typhoid diagnosis without Widal, blood culture, or appropriate antibacterial medicine.
4. Pregnancy-related diagnosis for male patient.
5. Prostate-related diagnosis for female patient.
6. Diagnosis present but no medicine, procedure, investigation, or service recorded.
7. Medicine-only claim with no diagnosis.
8. Duplicate medicine on the same claim.
9. Duplicate laboratory procedure on the same claim.
10. Inpatient claim without admission and discharge dates.

## Current Recommendation

Do not change production NHIS logic immediately. First add the rule catalog and warning-only advisory layer behind a feature flag, then test against historical claims before enabling it for pharmacies or hospitals.
