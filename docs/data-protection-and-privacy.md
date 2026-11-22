# HealthFlow data protection and privacy

Status: first version, 22 November 2026. This describes what the system does today and
what is still open. It is an engineering document, not legal advice. Items marked
**Decision** need the owner (and, where noted, a legal adviser) before anything is built.

## 1. What personal data the system holds

| Data | Where | Who can read it |
| --- | --- | --- |
| Staff: name, email, role, branch | Supabase Auth + `users` | Staff of the same facility, per role; platform super admins |
| Patients: name, phone, other contact fields | `patients` | Staff of the same facility with patient access |
| NHIS claims: member number, Ghana Card / HIN, patient name, patient telephone, diagnosis, medicines, prescriber | `nhis_claims` and related tables | Staff of the same facility with NHIS access; claims officers; exported to CLAIM-it by design |
| Prescription and claim attachments | Private storage buckets | Same facility, through links that expire |
| Sales and receipts | `sales` and related tables | Same facility, per role |
| Audit trail | `audit_logs` | Facility admins and others permitted by the Activity Log rules |
| Offline copy of the above | SQLite file on the branch server computer | Anyone with access to that computer |
| Browser storage | Sign-in session, branch token, queued CLAIM-it submissions | Anyone using that browser profile |

Health, diagnosis and medicine information, and national identifiers such as the Ghana
Card number, are the most sensitive items. Treat them as special personal data.

## 2. Controls in place today

- **Passwords.** Never stored by HealthFlow. Supabase Auth holds and hashes them. Staff
  passwords are at least 8 characters, and a temporary password is set through the
  `staff-admin` function only. Offline PINs are 6–12 digits, stored as a salted scrypt
  hash, locked for 15 minutes after five wrong tries, and every attempt is logged.
- **Stored third-party credentials** (CLAIM-it / NHIA keys) are encrypted with AES-256-GCM.
- **Isolation between facilities.** Row Level Security scoped by `organization_id` on
  tenant tables, branch scoping on top, and edge functions that check the signed-in user's
  facility before changing anything. Role permissions control each screen.
- **In transit.** HTTPS everywhere; the branch server uses HTTPS on the local network.
- **At rest in the cloud.** Supabase platform encryption at rest. No extra application-level
  encryption.
- **Files.** Prescription and attachment buckets are private; files open through expiring links.
- **Logs.** Request and sign-in diagnostics blank out fields named password, token, secret,
  API key, patient, member, HIN, Ghana, diagnosis, medicine or prescription.
- **Audit trail.** Records who did what to which record. From this release, phone, member
  and card numbers are kept only as their last three characters, and diagnosis, clinical
  notes, addresses and dates of birth are removed from audit details. Patient and staff
  names are kept on purpose: the Activity Log shows them as the subject of an entry, only
  to people allowed to identify that person. Older audit rows were written before this and
  are unchanged.
- **Backups and recovery.** See `BACKUP_AND_RECOVERY.md`. The Recycle Bin is not a backup.

## 3. Known gaps and what to do about them

### Gap A. No field-level encryption of the most sensitive fields

Today anyone with database-level access (platform owner, Supabase) can read diagnosis,
Ghana Card and member numbers. The fields are stored in plain columns because the app
searches them, checks duplicates and exports them to CLAIM-it.

Options:

1. **Keep as is, tighten access.** Few database admins, MFA on every privileged account,
   periodic review of the live security rules (see `docs/security-verification-checklist.md`).
   No code risk. Recommended first step.
2. **Encrypt free-text only** (clinical notes, diagnosis free text, patient notes). Moderate
   work, no effect on search by member or card number. Notes cannot then be searched in the database.
3. **Encrypt identifiers** (member number, Ghana Card, HIN). Breaks duplicate detection, search
   and exports unless blind indexes are added. High risk on 20,000+ live claims and touches the
   protected NHIS logic. Not recommended without a full design and a rehearsal on a copy of production.

**Decision:** option 1 now; option 2 only if a pharmacy or regulator requires it.

### Gap B. Audit details (fixed in this release, going forward)

Done. A one-off clean-up of older audit rows is optional and would be a database
migration that rewrites history. **Decision:** whether older rows should be cleaned.

### Gap C. The branch server file on disk is not encrypted

The offline SQLite file (`C:\HealthFlowLocal\data\healthflow-branch.sqlite`) holds patient,
claim and sales data in readable form. Only integration secrets inside it are encrypted.
Changing the database engine to an encrypting one would mean a new installer that cannot be
tested until the real-PC test is done. The practical control is **Windows disk encryption
(BitLocker) on the branch server computer** plus normal Windows account security.

- `scripts/check-disk-encryption.ps1` reports whether the drive holding the branch data is
  encrypted. Run it as Administrator on each branch server computer.
- Add it to the install and onboarding checklist (`PHARMACY_ONBOARDING_RUNBOOK.md`).

**Decision:** whether encrypted disks become a stated condition for offline-installer pharmacies.

### Gap D. Data kept in the browser

- The sign-in session is kept in the browser's local storage. This is how Supabase keeps staff
  signed in. Content Security Policy limits script injection; sign out on shared computers.
- The branch token is kept in the browser, by design, for the branch connection.
- Unsent CLAIM-it submissions are queued in the browser so they are not lost when the network
  drops. Clearing them at sign-out would lose unsent claims, so this is not done automatically.

Options: (a) accept and document, with a rule that shared computers use their own Windows
accounts and sign out; (b) expire queued submissions older than a set number of days after
they have been reported to the user. **Decision:** (a) or (b), and the number of days for (b).

### Gap E. No written privacy and retention policy

This document is the first step. Still needed, with a legal adviser:

- Whether each pharmacy, HealthFlow, or both are the "data controller" for the patient data,
  and whether registration with Ghana's Data Protection Commission is required under the Data
  Protection Act, 2012 (Act 843). Not established here.
- A privacy notice pharmacies can show patients.
- A data processing agreement between HealthFlow and each pharmacy.

**Retention. Decision:** the owner sets these. Suggested starting points, to confirm against
Pharmacy Council and NHIA record-keeping rules:

| Data | Suggested starting point |
| --- | --- |
| Dispensing, sales and claim records | Keep for the period regulators require; do not delete early |
| Audit trail | At least 12 months online, then archive |
| Diagnostic and request logs | 30–90 days |
| Closed or deleted pharmacy account | Export for the pharmacy, then delete after an agreed grace period |
| Recycle Bin | Review and purge on a schedule; it is not a backup |

### Gap F. Live verification not yet done

Two-factor sign-in on privileged accounts, the live security rules, and a backup restore test
have not been checked in production. See `docs/security-verification-checklist.md`.

## 4. Requests from patients

If a patient asks what is held about them, or asks for correction or deletion:

1. The request goes to the pharmacy, which decides it. HealthFlow supports it.
2. Search the patient by name, phone or member number in Patients and NHIS claims.
3. Correct through the normal screens (corrections are audited). Do not delete dispensing or
   claim records that the pharmacy must keep; remove only what is not required.
4. Record the request and outcome.

## 5. If personal data may have been exposed

Follow the incident steps in `SECURITY_HARDENING_RUNBOOK.md` (disable users, rotate tokens,
review audit logs, force password resets), then:

1. Write down what happened, when, which pharmacy, and which data.
2. Tell the affected pharmacy owner the same day.
3. With a legal adviser, decide whether the Data Protection Commission and affected people
   must be notified, and by when.
