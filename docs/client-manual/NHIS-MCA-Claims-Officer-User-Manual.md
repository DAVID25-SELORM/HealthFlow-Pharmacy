# HealthFlow NHIS User Manual

## MCA and Claims Officer Workflow

This manual explains how Medicine Counter Assistants (MCA) and Claims Officers should use the NHIS module in HealthFlow.

## Key Principle

HealthFlow separates two jobs:

- Claims Officer enters and prepares the NHIS claim.
- MCA serves the medicines that were already entered by the Claims Officer.

The claim value is based on what the MCA actually serves, not just what the Claims Officer requested.

Powered by Neon Digital Technologies - neondigitaltechnologies.com

## Roles and Privileges

### Assigned Roles

Assigned roles are the main work modes a staff member can switch between.

Examples:

- Medicine Counter Assistant
- Claims Officer
- Administrator

If a staff member has more than one assigned role, they will see a role selector at the top of the app. They must switch to the role they want to work as.

Example:

Sarah can have:

- Medicine Counter Assistant
- Claims Officer

If Sarah is in MCA mode, MCA restrictions apply. If Sarah switches to Claims Officer mode, Claims Officer actions become available.

### Additional Privileges

Additional privileges are extra permissions added on top of a role.

Examples:

- Refunds
- Inventory
- Sales
- Patients
- Purchases
- Stock adjustment
- Purchase approval
- NHIS deletion

Important:

- Use Assigned Roles for job mode switching.
- Use Additional Privileges for extra access.
- Do not give NHIS deletion or purchase approval unless the staff member is trusted to perform those actions.
- A staff member in MCA mode should not get full Claims Officer behavior just because they have a claims privilege. Assign the Claims Officer role if they must perform Claims Officer work.

## Claims Officer Workflow

### 1. Open NHIS

Go to:

```text
NHIS > Claims
```

### 2. Create a New NHIS Claim

Click:

```text
New Claim
```

Fill in:

- NHIS member number or Ghana Card number
- Card type
- HIN
- Surname
- Other names
- Folder number
- Gender
- Date of birth
- CC / CCC code
- Attendance details where applicable
- Prescribing facility
- Prescriber name or ID
- Diagnosis where required

### 3. Generate or Enter CC Code

Use:

```text
Generate/Validate CC Code via NHIA
```

The facility NHIA credentials are configured by the administrator. Staff do not need to enter NHIA credentials individually.

### 4. Add Requested Medicines

Click:

```text
Add Medicine
```

Enter the prescribed/requested medicine details:

- Medicine code or name
- Prescribed quantity
- Unit
- Unit price
- Dose
- Frequency
- Duration

The Claims Officer can see the requested cost before sending to MCA.

### 5. Send to MCA

After entering the patient and medicine details, click:

```text
Send to MCA
```

The claim status becomes:

```text
Pending Serving
```

At this stage, the claim is not ready for submission. The MCA must serve the medicine first.

## MCA Workflow

### 1. Open NHIS

Go to:

```text
NHIS > Claims
```

MCA should focus on claims with status:

```text
Pending Serving
```

### 2. Open a Claim

Click the edit/serve button on the pending claim.

The MCA will see the medicines entered by the Claims Officer.

### 3. Serve Medicines

For each medicine, MCA should click the medicine edit/serve button and enter what was actually served.

MCA can mark each medicine as:

- Fully Served
- Partially Served
- Not Available
- Not Served

### 4. Quantity Rules

The Claims Officer's requested quantity remains as the prescribed quantity.

The MCA enters the served quantity separately.

Example:

| Medicine | Prescribed Qty | Served Qty | Status |
| --- | ---: | ---: | --- |
| Paracetamol | 20 | 20 | Fully Served |
| Amoxicillin | 21 | 0 | Not Available |
| Vitamin C | 30 | 15 | Partially Served |
| Omeprazole | 14 | 0 | Not Served |

The claim amount is calculated from the served quantity.

### 5. If Medicine Is Not Served or Not Available

If a medicine is not fully served, select the correct status and reason.

Common reasons:

- Out of stock
- Insufficient stock
- Patient refused
- Medicine changed
- Entered by mistake
- Other

Do not delete the medicine just because it was not served. Mark it correctly so the Claims Officer can review what happened.

### 6. Save Medicines

After serving, click:

```text
Save Medicines
```

The claim is returned for Claims Officer review.

## Claims Officer Review After MCA Serving

After MCA saves medicines, the Claims Officer reviews the claim.

Check:

- Prescribed quantity
- Served quantity
- Medicine status
- Reasons for partial or not served medicines
- Claim total
- Patient and CC details
- Prescriber details
- Prescription attachment where required

When everything is complete, the Claims Officer can mark the claim ready for submission/export.

## Patient Return Alert

HealthFlow may show a Patient Return Alert if the same patient visited within the configured alert window, such as 24 hours.

The alert appears even if the medicine is different.

Before continuing, verify:

- Previous visit date/time
- Branch
- Medicines served
- Staff involved
- Claim status

If continuing, select the reason:

- Follow-up treatment
- Doctor changed medicine
- Patient complaint
- Emergency
- Other

## Duplicate Medicine Alert

If the same medicine is being supplied again within the configured duplicate window, HealthFlow may show a duplicate dispensing warning.

This is separate from the Patient Return Alert.

Use this warning to prevent accidental repeated dispensing.

## What Each Role Can Do

### MCA Can

- View NHIS claim serving details
- Serve medicines entered by Claims Officer
- Enter served quantity
- Mark medicine as fully served, partially served, not available, or not served
- Save medicines for Claims Officer review

### MCA Cannot

- Generate or change CC code
- Freely add new NHIS medicines by default
- Change patient NHIS details
- Finalize claim for submission
- Delete NHIS claims

### Claims Officer Can

- Register/search NHIS patient
- Generate or enter CC code
- Fill NHIS patient details
- Enter prescribed/requested medicines
- Send claim to MCA
- Review MCA served quantities
- Approve claim after serving
- Prepare claim for export/submission

### Claims Officer Cannot Unless Given Permission

- Delete NHIS claims
- Approve purchases
- Perform restricted admin-only actions

### Administrator Can

- Assign roles
- Add or remove privileges
- Decide who can delete NHIS claims
- Decide who can approve purchases
- Edit staff accounts
- Configure facility-level NHIA credentials

## Important Do's and Don'ts

### Do

- Claims Officer should enter the prescribed/requested medicines.
- MCA should enter only the actual served quantity.
- Use partial/not served reasons honestly.
- Review served quantities before final submission.
- Keep NHIA credentials at facility level through Settings.

### Don't

- Do not let MCA work in Claims Officer mode unless assigned and intended.
- Do not give NHIS deletion to ordinary staff.
- Do not submit claims before MCA has served medicines.
- Do not delete unserved medicines just to clean up the claim.
- Do not share admin passwords.

## Troubleshooting

### Claim Is Pending Serving

This means it is waiting for MCA to serve medicines.

### Claim Is Returned for Review

This means MCA has saved serving details and Claims Officer must review it.

### Claim Total Is Zero

Check whether MCA entered served quantity. Requested quantity alone does not create the claim amount.

### MCA Cannot Save

Check that:

- Served quantity is entered where medicine is served.
- Status is correct.
- Reason is provided for partial or not served medicine.

### Claims Officer Cannot Finalize

Check that:

- MCA has served at least one medicine, or marked the medicines correctly.
- Required patient details are complete.
- Required prescriber details are complete.
- Required attachments are present where needed.

## Best Practice Summary

```text
Claims Officer enters the prescription.
MCA records what was actually served.
Claims Officer reviews and finalizes.
Admin controls roles and sensitive privileges.
```
