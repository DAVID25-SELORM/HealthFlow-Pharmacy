# HealthFlow User Manual

**Version:** 1.1  
**Updated:** 1 July 2026  
**Audience:** Facility administrators, pharmacists, claims officers, MCA staff,
cashiers, inventory staff, accounting staff, and supervisors.

## Review before consequential actions

HealthFlow shows a final review message before actions that materially change
clinical, financial, inventory, or fulfilment records. Read the identifiers,
amounts, status, and warning before selecting **OK**.

This review is used for claim approval/rejection, NHIS dispatch/direct serving/
submission/payment, purchase completion, refunds, inventory removal, cashbook
closure and adjustments, insurer payments, and e-pharmacy status changes.
Selecting **Cancel** leaves the record unchanged. Normal draft/detail saves
remain immediate so staff can continue work without unnecessary prompts.

## 1. Sign-in and roles

- Every staff member must use an individual account.
- The active role selector controls the work mode for staff with multiple roles.
- Administrators assign roles and additional privileges in **Settings > User
  Management**.
- Never share cloud passwords, administrator accounts, offline PINs, branch
  tokens, or NHIA credentials.

## 2. Dashboard and navigation

The sidebar exposes only modules allowed for the active role and facility
subscription. Use the search, filters, pagination controls, and sticky
previous/next controls instead of repeatedly scrolling long lists.

## 3. Inventory and POS

Inventory records batches, expiry dates, quantities, cost prices, selling
prices, NHIS codes, and facility-level restrictions. POS sales reduce inventory
and create auditable stock movements. NHIS claim serving is separate: it does
not require or change HealthFlow inventory stock.

Before using POS, enter the opening cash amount and select **Open Shift**.
Until a shift is open, medicine search, selection, patient linking, refunds,
and checkout remain locked. The Local Branch Server applies the same rule
during an internet outage and validates that the open shift belongs to the
signed-in staff member and assigned branch. Close the shift at handover or the
end of duty and record the counted cash.

When an administrator deletes an inventory item, HealthFlow archives it in
**Recycle Bin** and makes it inactive. Restore it from Recycle Bin when deletion
was accidental. Permanent deletion is an administrator-only action.

## 4. Patients and general insurance claims

Search before creating a patient to avoid duplicates. General insurance claims
remain in the **Claims** module. NHIA/NHIS medicine claims, CCC verification,
attachments, tariffs, and CLAIM-it operations remain in the **NHIS** module.

Select **View History** on a patient to see sales and claims with their medicine
lines. NHIS entries show prescribed quantity, served quantity, and serving
status. History is loaded only when opened so the main patient list remains
fast.

## 5. NHIS pharmacy workflow

Claims Officers have three distinct actions:

1. **Save Details** saves a draft without sending it to the dispensary.
2. **Send to Dispensary** sends the same claim to MCA/dispensary staff.
3. **Serve Directly** marks all entered medicine quantities fully served and
   moves the claim directly to **Served / Claim Ready**. It is available to
   authorized Claims Officers in both pharmacies and hospitals.

An intake may be saved or sent with medicines, an attachment, both, or neither.
The claim displays **Incomplete Intake** until required information is added.

### Temporary hospital tariff coverage

Until NHIA supplies the remaining current facility-specific schedules,
HealthFlow uses the verified 617-item **FEB 2023 Private Primary Care Hospital
(Catering Exclusive)** schedule as the temporary price master when a hospital's
exact tariff set is unavailable. The application labels this fallback clearly.
Hospital provider-class, service-type, diagnosis, age-band, and clinical
controls still apply. When a matching approved tariff is loaded later,
HealthFlow automatically prefers that facility-specific set.
For pharmacy claims, a prescription attachment is mandatory before final
submission, even though it is not mandatory for initial saving or dispatch.

### Direct serving

- Available to an authorized Claims Officer or administrator.
- Requires at least one medicine with a positive prescribed quantity.
- Does not check, add, or deduct inventory stock.
- Does not wait for MCA input and does not appear as MCA work.
- Is recorded once with the staff member and timestamp.
- Claims Officer/admin may reopen the claim for corrections.
- Final submission remains blocked until mandatory patient, prescriber,
  authorization, attachment, and other readiness requirements are complete.

### Dispensary/MCA serving

MCA opens **Pending Serving** claims, records the actual served quantity and
status for each medicine, and saves the work for Claims Officer review. Partial,
unavailable, and not-served lines require the appropriate reason. MCA cannot
change claims already served directly by a Claims Officer.

### Existing claims

Existing claims retain their current status and data. Only claims using **Serve
Directly** receive the direct-serving marker. Ordinary pending claims continue
through MCA; ordinary previously served claims retain the existing review/edit
window.

## 6. NHIS corrections, attachments, and deletion

Claims Officers can reopen their claim to add/correct medicines, attach the
prescription, or complete missing details without creating another claim.
Changes are audited and protected from stale simultaneous edits.

Deleted NHIS claims are archived in **Recycle Bin**, including claim, medicine,
and tariff-service snapshots. Administrators can restore or permanently delete
them. Prescription objects are retained while the claim is recoverable.

## 7. Reports and accounting

Use role-appropriate reports for sales, inventory, medicine consumption, NHIS
claims, Claims Officer activity, submissions, receivables, and audit review.
Accounting sales summaries are aggregated in PostgreSQL rather than downloading
every sale line to the browser.

## 8. Offline and facility LAN operation

The Local Branch Server supports local SQLite operation, synchronization, and
facility-wide LAN access.

- **Download and Install** in Offline Sync downloads the first-time HealthFlow
  workstation installer for a new computer. The installer sets up the local
  branch server, offline app, local database, service/startup entry, shortcut,
  local API token, and workstation connection pieces.
- **Download Setup Details** saves the facility/setup notes needed during
  installation and handover.
- **Branch Sync Setup** registers the facility machine for cloud sync and can
  generate the `BRANCH_SYNC_TOKEN` used by the local server after installation.
- The **Local Branch Token** saved in the browser is the local API access token
  used for protected calls to the branch server.
- **Check for Updates** and **Download Update** update an already installed and
  connected local branch server/offline app.

- Each user enrolls a separate 6–12 digit offline PIN.
- Only a salted scrypt hash is stored on the facility branch server.
- One facility PIN works from authorized computers connected to that facility
  server; it is not a cloud password.
- Five failed attempts lock access for 15 minutes.
- Every attempt is logged locally.
- Administrators can enable, reset, or revoke offline access.

Facility-wide access requires trusted HTTPS. Default certificate paths are:

```text
C:\HealthFlowLocal\certs\server.crt
C:\HealthFlowLocal\certs\server.key
```

When TLS is missing or invalid, the server reports **TLS Not Configured** and
uses local-only access. Workstations must use the administrator-generated,
single-use **Connect This Computer** bundle.

## 9. Administration

- Review staff roles and privileges monthly.
- Disable departing staff immediately.
- Review Recycle Bin, audit logs, failed sync events, backups, TLS status, and
  offline-login failures.
- Keep Supabase, payment, SMTP, NHIA, branch, and signing secrets out of the
  browser and repository.

## 10. Troubleshooting

| Situation | Action |
| --- | --- |
| Incomplete Intake | Reopen the same claim and complete missing information. |
| Pending Serving | MCA/dispensary has not completed serving. |
| Directly served claim appears to MCA | Refresh after deployment; report if it remains editable. |
| Claim cannot be submitted | Resolve the readiness blockers, especially the pharmacy prescription attachment. |
| Browser says free up space | Free device/browser storage; this is a machine storage warning. |
| Offline login is locked | Wait 15 minutes or ask an administrator to reset/revoke access. |
| TLS Not Configured | Install a trusted certificate or use the automated facility installer. |
| Sync repeatedly fails | Preserve data, record the exact error, and contact support. |

## 11. Daily controls

- Confirm connectivity and branch-server status.
- Verify the active role before working.
- Search before creating patients or claims.
- Review incomplete claims and pending sync.
- Close cashier shifts and verify backups according to facility policy.
