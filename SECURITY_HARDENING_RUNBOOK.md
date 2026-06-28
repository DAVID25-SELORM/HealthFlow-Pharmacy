# HealthFlow Security Hardening Runbook

This document records the security model for HealthFlow Pharmacy.

No software can be guaranteed impossible to hack. The goal is layered security: strong authentication, database row isolation, minimal secrets in browsers, hardened deployment headers, careful local server setup, backups, monitoring, and a realistic encryption plan.

## 1. Encryption Model

### What Is Already Encrypted

- Browser to HealthFlow/Vercel uses HTTPS/TLS.
- Browser to Supabase uses HTTPS/TLS.
- Supabase stores data in managed infrastructure with platform-level security controls.
- Local branch sync to Supabase uses HTTPS/TLS.

### End-To-End Encryption Reality

True end-to-end encryption means the server/database cannot read the protected data. That is not fully compatible with current HealthFlow features because the app needs Supabase to query, filter, report, search, and aggregate pharmacy data.

Do not claim the whole app is end-to-end encrypted unless the product is redesigned so encryption/decryption keys live only with the pharmacy and the cloud never sees plaintext.

### Practical Recommendation

Use **field-level encryption** only for the most sensitive fields if needed, such as:

- patient notes
- diagnosis notes
- insurance identifiers
- uploaded prescription metadata

Keep operational fields searchable and reportable, such as:

- drug names
- quantities
- sale totals
- purchase totals
- branch IDs
- timestamps

Full E2EE should be a separate future module with clear tradeoffs: less cloud reporting/search, key recovery complexity, and stronger operational discipline.

## 2. Supabase Security Requirements

Always enforce:

- Row Level Security enabled on tenant tables.
- Every tenant table scoped by `organization_id`.
- Users can only read/write rows for their own organization.
- Super admin access must be explicitly controlled.
- Edge functions must validate the authenticated user and organization before mutation.
- Never expose service role keys in frontend code, browser storage, Vercel public variables, or local cashier computers.

Recommended production checks:

```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

For sensitive tables, `rowsecurity` should be `true`.

## 3. Frontend Security Controls

The app should use:

- Content Security Policy
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy`
- HTTP Strict Transport Security
- clean session expiry handling
- no service role secrets in frontend bundles

Check generated frontend bundle for accidental secrets before release:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
npm.cmd run build
rg -n "service_role|SUPABASE_SERVICE|secret|private_key|BRANCH_SYNC_TOKEN" dist
```

## 4. Local Branch Server Security

The local branch server is powerful because it can create local sales and sync records.

Required controls:

- Use a long random `BRANCH_SERVER_TOKEN`.
- Use a separate long random `BRANCH_SYNC_TOKEN`.
- Do not reuse tokens across pharmacies.
- Do not send tokens through WhatsApp or public documents.
- Store tokens in a password manager or secure admin record.
- Allow only LAN/private origins to call the local server.
- Open only port `4780` on the branch server computer.
- Keep the branch server computer physically secured.
- Never expose the branch API to the LAN over plain HTTP. Use loopback-only
  HTTP for a single computer, or configure `HOST=0.0.0.0` with
  `HEALTHFLOW_TLS_CERT_PATH` and `HEALTHFLOW_TLS_KEY_PATH`.

Generate tokens:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Optional strict CORS for local branch server `.env`:

```env
ALLOWED_ORIGINS=http://localhost:5173,https://healthflowcloud.com,https://healthflow-branch.facility.example:4780
```

Same-origin requests from the bundled HTTPS application are allowed
automatically. List any additional trusted HTTPS origins explicitly.

## 5. Password And Account Rules

Recommended:

- Require staff passwords with at least 8 characters.
- Encourage password manager use.
- Use Supabase password reset for forgotten passwords.
- Disable inactive staff accounts immediately.
- Give every person their own login.
- Do not share admin accounts.
- Review staff roles monthly.

## 6. Subscription And Access Security

Do not rely only on hidden sidebar links.

Every protected module should enforce access in:

- frontend route guards
- service calls
- Supabase RLS or server-side RPC checks

Expired/suspended pharmacies should not lose data. Use access restriction, not deletion.

## 7. Backups

Production backup policy:

- Daily Supabase backups if available on the chosen plan.
- Weekly manual export during early deployments.
- Export onboarding records without live secrets.
- Test restore process before onboarding many pharmacies.

## 8. Monitoring

Review:

- Supabase auth logs
- Edge function logs
- failed sync records
- unexpected 401/403 spikes
- unusual super admin activity
- repeated failed login attempts

## 9. Release Checklist

Before each production push:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
npm.cmd run test
npm.cmd run build
rg -n "service_role|SUPABASE_SERVICE|private_key|BRANCH_SYNC_TOKEN" src public local-branch-server
```

For the local branch server:

```powershell
cd "C:\Users\RealTimeIT\Desktop\APPS\HealthFlow Pharmacy"
Get-ChildItem local-branch-server\src -Filter *.js | ForEach-Object { node --check $_.FullName }
```

## 10. Incident Response

If a pharmacy account or local server token is suspected compromised:

1. Disable affected staff users.
2. Rotate `BRANCH_SERVER_TOKEN`.
3. Rotate `BRANCH_SYNC_TOKEN`.
4. Update Supabase branch sync client token.
5. Review audit logs and sync outbox.
6. Force users to reset passwords.
7. Confirm no service role key was exposed.
