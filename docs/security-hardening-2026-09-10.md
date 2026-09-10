# Security hardening — 10 September 2026

This pass covers repository dependencies, CLAIM-it proxy paths, existing access-control tests, and deployment header configuration. It does not establish that production is free of vulnerabilities or verify live Supabase policies, account MFA, hosting firewall settings, backups or administrator access.

## Changes

- Updated vulnerable dependencies, including React Router 7.18.3. The router advisory identifies a navigation bypass affecting versions before 7.18: https://github.com/advisories/GHSA-wrjc-x8rr-h8h6. This is a major-version update and requires normal login/navigation regression checks before live rollout.
- Both CLAIM-it proxies now validate each decoded path segment and constrain the resulting URL to the configured upstream API path before forwarding credentials. Dot segments, encoded separators, nested percent encodings, control characters and query/fragment injection are rejected. Valid IDs and query parameters continue to work. Existing bridge-token requirements remain enforced.
- Removed raw upstream exception details from proxy error responses.
- Updated branch-server dependencies and constrained its transitive `qs` parser to the patched 6.16 series (Express's declared range otherwise retained an affected parser). Existing installed branch servers require a new installer release; no running service was restarted.
- Added proxy request tests exercising hostile paths, valid routing and missing credentials. Added a CI audit gate for high/critical production dependency alerts and weekly dependency-update PR configuration.

## Existing controls reviewed

The deployment configuration includes CSP, frame blocking, MIME-sniffing protection and HSTS. Existing database contracts cover tenant RLS and self-privilege-escalation prevention. These source controls need to be deployed to protect live traffic. A limited filename-only scan of tracked files found no matches for private-key blocks, Supabase secret-key patterns or live Stripe-style secret keys; this is not a comprehensive historical secret scan.

## Live follow-up

Verify MFA and recovery access for privileged hosting/database/source-control accounts; inspect live RLS and security-advisor results; confirm deployed security headers; verify rate limits for login, signup and public endpoints; test backup restoration. Do not rotate shared credentials without coordinating their consumers. The existing production security SQL diagnostics can support a read-only database review.

## Verification results

The updated root dependency audit (including development tooling) and branch-server production dependency audit report zero known vulnerabilities. Protected baseline hashes and all 111 migration checks passed. The 136 contract tests passed; final plain lint, the complete suite (149 files / 949 tests), and production build passed. The full suite ran after the branch-server parser update. A build plugin timing notice is informational. No credentials were rotated, production SQL applied, or running branch service restarted. The user authorized publication after verification. Live rollout verification remains outstanding.
