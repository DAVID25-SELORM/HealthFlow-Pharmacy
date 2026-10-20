# NeHFAMS connection preparation

Local branch: feat/nehfams-connection-preparation. No live NHIA calls performed.

Provider identifiers remain distinct: existing, otac (portal Bearer token), nehfams (NHIA HMIS API key/secret).
The supplied HFAMS - HMIS Vanilla collection confirms paths in nehfamsAdapter.ts.
Production origin is https://nehfams.nhia.gov.gh. The collection supplies no response examples or base-url variable value.
DevTools routes are deliberately not implemented. No token exchange, refresh, member verification or retrieval schema is invented.

Selecting and saving NeHFAMS pauses generation for that organization. This is explicit in the UI.
The SQL constraint prevents enabling it, and backend dispatch rejects it before reservation or network access.
Credentials use the existing AES-GCM backend encryption; separate service-only RLS storage; no credential reveal endpoint.
Saving checks active super-admin privileges and locks the organization policy; unresolved requests prevent switching.
Legacy and OTAC credentials are retained. Existing ledger/history are untouched. To resume a verified existing provider,
select it and explicitly enable generation. Saving a NeHFAMS credential is not a connection test.

Before deployment: apply 20261020200000_prepare_nehfams_connection.sql, deploy tier-access with its shared modules,
then deploy the frontend. Do not deploy without the migration. No tenant is automatically switched.
Rollback: restore each affected organization's prior provider via the administrator workflow, retaining all history and secrets.
Do not remove the database constraint to activate NeHFAMS. Activation requires a separate reviewed implementation.

Outstanding: response schemas and business error meanings, HP-info facility identity mapping, approved OTAC acquisition
workflow, exact authorized test URL, duplicate/retrieval behavior and authorized test data. Credentials already supplied
must not be committed or embedded in the frontend. Production credentials were not imported by this preparation.
