# NHIS serving form: optional patient telephone

Date: 2026-11-22

Pharmacy users asked to add the patient's telephone number to the NHIS form while
serving. This change adds an optional "Patient Telephone" box to the NHIS claim
form.

## Why the number is kept on the claim

At the time of writing only 43 of about 20,957 NHIS claims are linked to a row in
`patients`. Nearly every NHIS patient exists only through their claims, so saving
the number on the patient record alone would almost never work. The number is
kept on the claim and carried forward to that member's next claim.

## Behaviour

- New optional box on the NHIS claim form (new claim and edit claim).
- When a patient is picked, the box is filled from the patient record's phone, then
  from the member's most recent earlier claim that has a number
  (`getLatestNhisPatientPhone`). A number the user has already typed is never
  overwritten.
- After the claim has saved, the number is saved as a separate step
  (`saveNhisClaimPatientPhone`): `nhis_claims.patient_phone`, plus
  `patients.phone` when the claim is linked to a patient record and the number
  differs. An audit event `nhis_claim.patient_phone_saved` is recorded (it does
  not contain the number).
- If that step fails, the claim is still saved and served; staff see a warning.
- In offline / branch-server mode the number is not saved and staff are told.
- A number that does not look like a Ghana number only produces a warning.
  Optional; never blocks saving or serving.

## Not changed

- The claim create and update payloads, the privileged correction function
  (`correct_nhis_claim_privileged`), the offline sync function, serving guards,
  stock handling and NHIA/CXF exports. The telephone is intentionally outside all
  of these (a contract test keeps `patient_phone` out of the claim save code).
- `src/services/nhisService.js` only gains two new exported functions at the end
  of the file; no existing function was edited.

## Database

New additive migration `20261122090000_add_nhis_claim_patient_phone.sql`: one
nullable column `nhis_claims.patient_phone`. Applied by hand and verified on
2026-11-22 (column present, no claim has a number). Rollback only removes the
column. If the front end is deployed before the column exists, the box shows and
saving the number warns; nothing else is affected.

## Tests

`src/utils/ghanaPhone.test.js` and
`src/contracts/nhisServingPatientPhone.contract.test.js`.
