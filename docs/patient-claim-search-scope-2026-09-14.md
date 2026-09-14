# Patient claims search scope

The reported patient card shows four visits, while the supplied NHIS search screenshot shows one claim. The screenshots do not show the active date/status filters or establish that all four visits are NHIS claims.

Code findings:
- The patient workspace counts NHIS claims across dates plus sales.
- NHIS claims default to the current month; searching retains date, status, and issue filters.
- Patient View History is a separate modal, not the NHIS list shown in the screenshot.

Added a search-scope notice and an explicit Search all dates and statuses action. It preserves the search term, resets paging, clears date/status/issue filters (including the URL status), and uses the existing scoped queries and permissions. No patient records or migrations were changed.

Live patient verification is pending: the browser tool failed twice with Unable to load browser request-header policy. Do not treat this change as proof that all four visits have been recovered. Confirm View History and an all-dates NHIS search in West Point after release; investigate record matching if the discrepancy remains.

## Subsequent screenshot evidence

All dates, all statuses, and all issues still return only NHIS-009105 for the member-number search. Patient history shows zero sales and two claims: NHIS-009105 (14 September) and NHIS-009067 (12 September). This rules out the date-filter explanation for this incident. The search-scope UI improvement is not a fix for this discrepancy.

Patient history resolves additional identity links, whereas claim search matches the fields on each claim. Compare both records with docs/diagnostics/west-point-patient-history.sql before changing identity matching or data. The query is read-only and has not been run against production. Check organization identifiers because claim numbers may repeat between organizations.

## Confirmed diagnosis

User-provided SQL results show different member numbers/HINs on the two claims, with the same name and folder. Claim-specific member search therefore returns one, while patient history groups both. No identity fields should be overwritten without source-document confirmation.

## Correction editor layout

Replaced the expanded readiness lists with a persistent compact count summary and a collapsed, scrollable disclosure. Shared serving/export blockers appear once; export counts still include serving blockers. Original scrub-review issues are separately expandable and no longer truncated to six. Validation contracts and saving behavior are unchanged. Live screenshot verification remains unavailable due to the browser connection failure.
