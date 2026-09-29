# NHIS prescription upload recovery

The reported failures are Storage HTTP 400s for scanned PDFs/JPEGs, tier-access HTTP 400s, a password-login HTTP 400, and an NHIS navigation HTTP 503. The affected role is admin. Response bodies were not supplied, so these status lines alone do not establish a single production root cause.

Confirmed code defects addressed:

- File validation accepts scanner PDFs/images by extension, but Supabase's multipart upload uses the File/Blob MIME type, ignoring the contentType option for that part. Normalize the upload Blob to the already-resolved allowed type without changing its bytes, stored path, or original display name.
- Prescription uploads previously bypassed the claim-write session recovery. Require a current session immediately before upload and refresh/retry once for an explicit JWT or RLS rejection. Reuse the same path/body. Do not retry arbitrary 400s, MIME/size errors, or server errors; preserve genuine permission failures.
- Do not mislabel any error mentioning a bucket as a missing bucket.
- Navigation previously cached unsuccessful responses as index.html. Cache only successful HTML, and use a healthy existing shell for HTTP 5xx/network failures. Do not reuse an already-cached error response.

No database policies, role grants, clinical validation, claim state transitions, attachment content, Edge Function behavior, or login credentials change. No database/Edge Function deployment is required for these changes.

Regression coverage exercises MIME normalization with unchanged PDF bytes, fresh/stale/missing sessions, one-shot Storage rejection recovery, non-retryable failures, and navigation cache behavior. Existing NHIS serialization, auth, upload-session, and production contract suites are also checked. The public /nhis and / routes returned HTTP 200 during investigation; this does not prove authenticated uploads work in production. The tier-access and password-login failures still require their response bodies to diagnose.

Validation: all 426 tests in the focused NHIS/upload/production-contract run passed. Lint, production build, protected-baseline verification, and migration validation passed. Initial contract failures were caused by Windows CRLF checkout; rerunning against LF source passed without changing those contracts.
