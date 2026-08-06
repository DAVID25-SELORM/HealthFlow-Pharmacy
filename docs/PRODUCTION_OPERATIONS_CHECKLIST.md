# HealthFlow Production Operations Checklist

Use this checklist after NHIS export, offline installer, print, or performance changes. It keeps live verification consistent without changing CCC, pricing, tariff, duplicate, submission, or CLAIM-it business logic.

## 1. CLAIM-it CXF Acceptance

1. Export a fresh CXF from HealthFlow for the target claim month.
2. Import the file into CLAIM-it on a test workstation.
3. Confirm Ghana Card-linked claims do not show `First 5 characters of Card Serial No. must be alphabetic`.
4. Confirm ordinary NHIS claims import without new identifier warnings.
5. If CLAIM-it rejects a claim, record:
   - Claim number
   - Member number shown in CLAIM-it
   - HIN shown in HealthFlow
   - CCC
   - CLAIM-it validation message

Expected identifier export:

- Ghana Card-linked member: exported member number is the verified HIN; card serial is blank.
- Ordinary NHIS member: exported member number is the NHIS number; card serial is blank.

Old claims do not need re-saving when a valid HIN is already stored. Claims with missing or invalid HIN must be corrected before export.

## 2. Scrub Correction Workflow

1. Open NHIS.
2. Click `Final export check`.
3. Search the scrub issue modal by claim number, patient name, member/HIN, folder, CCC, and issue text.
4. Click `Open correction`.
5. Confirm the opened claim shows the correction context panel at the top.
6. Correct the issue and save.
7. Use `Next` and `Previous` to continue through the correction queue.
8. Re-run `Final export check`.

Warnings require a claims officer or admin override reason before export. Hard errors must be corrected.

## 3. Receipt Print

1. Complete or open a sale receipt.
2. Click `Print Receipt`.
3. In the browser print preview, confirm only the receipt is visible.
4. Confirm the receipt text is dark and readable.
5. Confirm the output fits the configured receipt printer width.
6. If the receipt is longer than one page because of many items, confirm page breaks occur between rows and no text is cut off.
7. Confirm `Download PDF` still works separately.

Recommended browser print options:

- Paper size: receipt roll or 80 mm where available
- Scale: 100%
- Margins: default or none, depending on printer driver
- Background graphics: enabled only if the facility wants branded colors

## 4. Offline Installer End-to-End

Super Admin:

1. Build the installer.
2. Open `Installer Releases`.
3. Upload the ZIP.
4. Confirm version, filename, file size, SHA-256, and private storage path are filled.
5. Add release notes.
6. Validate the release.
7. Publish only after validation passes.
8. Enable offline download only for tenants/facilities that are permitted.

Facility user:

1. Open `Offline Sync`.
2. Confirm download is visible only when the Super Admin has permitted it.
3. Click `Download and Install`.
4. Install on a clean Windows workstation.
5. Register the machine to the correct organization and branch.
6. Run first sync while internet is available.
7. Confirm local server, local database, inventory, patients, settings, and claims sync.
8. Disconnect internet and confirm supported offline workflows open normally.

## 5. Two-Gigabyte Production Watch

During the first 24-48 hours after returning the Supabase project to 2 GB compute:

1. Watch login time.
2. Watch NHIS page load time.
3. Watch patient search and inventory search.
4. Watch export timing.
5. Watch Supabase function logs for:
   - `WORKER_RESOURCE_LIMIT`
   - `statement timeout`
   - repeated `500`
   - repeated `546`
6. Keep health polling warnings informational unless independent authenticated requests also fail.

If the app remains stable for a full operating day, keep 2 GB. If resource errors return after query optimization, profile the exact slow endpoint before increasing compute again.

## 6. Monthly Admin Routine

1. Confirm facility settings and NHIA credentials.
2. Confirm provider type and level are correct.
3. Confirm prescribers and prescribing facilities are populated.
4. Run `Final export check`.
5. Correct blockers first, then review warnings.
6. Export CXF.
7. Import into CLAIM-it.
8. Record CLAIM-it validation results.
9. If CLAIM-it rejects any claim, correct it in HealthFlow and re-export.
10. Keep the exported CXF and CLAIM-it validation report together for audit.
