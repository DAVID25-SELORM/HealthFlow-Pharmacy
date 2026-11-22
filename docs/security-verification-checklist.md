# Security verification checklist (live system)

The code-level controls are tested on every change. These items can only be checked in the
live dashboards or against the live database. Tick each one with the date and who checked it.

## 1. Database rules (read-only SQL, no patient data is returned)

Run `supabase-audit-production-security-quick.sql` in the Supabase SQL Editor of the
production project. It reads metadata only. Look for:

- tables in `public` with Row Level Security **off** (should be none for tenant tables);
- tables with no policies;
- functions that are `SECURITY DEFINER` and executable by `anon`;
- storage buckets that are public (prescription and claim buckets must be private).

Record any finding and fix it in a reviewed migration. Do not change policies from the dashboard.

## 2. Two-factor sign-in on privileged accounts

Switch on two-factor sign-in (authenticator app) and store recovery codes safely for:

- [ ] Supabase account(s) with access to the production project
- [ ] Vercel account(s)
- [ ] GitHub account(s) with write access to the repository
- [ ] The domain registrar / DNS account
- [ ] Every HealthFlow `super_admin` user: confirm in Supabase Auth that a factor is enrolled
  (the app's own sign-in does not yet require one)

## 3. Backups

- [ ] Confirm the production project's backup type and retention in Supabase (daily backups or point-in-time recovery).
- [ ] Restore the latest backup into a **separate, new** project and check that a known pharmacy's
  patients, claims and attachments are present. Never restore over production.
- [ ] Delete the test project and any copied data afterwards.
- [ ] Do the same for one branch server backup (`BACKUP_AND_RECOVERY.md`).

## 4. Secrets

- [ ] Search the deployed bundle for secrets: `rg -n "service_role|SUPABASE_SERVICE|private_key|BRANCH_SYNC_TOKEN" dist`
- [ ] Confirm the Supabase personal access token used for the CLI is deleted if no longer needed.
- [ ] Confirm no service-role key is in any Vercel public variable.

## 5. Branch server computers

- [ ] Run `scripts/check-disk-encryption.ps1` as Administrator on each branch server computer.
- [ ] Each person signs in to Windows with their own account; no shared admin account.
- [ ] Branch and sync tokens are unique per pharmacy and stored in a password manager.
