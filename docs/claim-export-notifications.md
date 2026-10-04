# Claims export notifications

Apply 20261004160000_claim_export_notifications.sql, then deploy the frontend and the claim-export-mail Edge Function.
The CXF generation path queues notifications only after every audit chunk completes. The existing export-record retry also retries the notification queue. Identical artifact/month alerts are deduplicated. A regenerated artifact is a new export.

Notifications describe generated CXF files, NOT NHIA acceptance, a successful external submission, or proof the browser saved the download. Other export formats and direct API submission are not covered by this implementation.
Facility active admins receive emails; daventratech@gmail.com receives an owner copy. Active platform super admins and facility admins see unread in-app notifications within 60 seconds. No patient data is included.

## SMTP setup
The Auth SMTP settings are not automatically available to Edge Functions. Copy the existing provider credentials into Edge Function secrets through the Supabase dashboard:
- SMTP_HOSTNAME (or existing SMTP_HOST)
- SMTP_USERNAME (or existing SMTP_USER)
- SMTP_PASSWORD (or existing SMTP_PASS)
- SMTP_FROM (approved sender address)
- EXPORT_MAIL_WORKER_SECRET (new strong random secret)

The worker uses TLS SMTP port 465. Confirm the existing provider supports it. Never store credentials in git or VITE_* variables.
Deploy: supabase functions deploy claim-export-mail --no-verify-jwt
The worker performs its own authorization against EXPORT_MAIL_WORKER_SECRET. It is not callable by ordinary user JWTs.
Configure a trusted scheduler (Supabase Cron with secrets in Vault, or your backend scheduler) to POST once per minute to /functions/v1/claim-export-mail with Authorization: Bearer <EXPORT_MAIL_WORKER_SECRET>. Do not put the secret in shared SQL or browser code.
Each call leases up to 2 messages; invoke more frequently if volume requires it. Configure the scheduler before expecting delivery.

## Delivery checks
Use a test facility and an authorized test export; verify facility and owner inboxes and the dashboard alert. No live email has been sent by implementation tests.
Inspect claim_export_mail_queue as an administrator for pending/sending/sent/failed and attempts. Failures retry after five minutes, up to five attempts. A crash leaves a ten-minute lease; jobs with five expired attempts are marked failed on the next worker run and require operator review. SMTP acceptance is not proof of inbox delivery. A crash after SMTP acceptance but before acknowledgement may cause a duplicate email; Message-ID is stable but SMTP does not guarantee exactly-once delivery.
Missing SMTP configuration leaves the queue unchanged and returns 503. Failed mail never invalidates the generated export. Auth settings remain unchanged.

