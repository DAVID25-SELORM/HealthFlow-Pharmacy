# Facility connectivity

Implementation prepared for repository delivery. Production migration and live acceptance remain pending.

Super admins can view **Platform Dashboard → Facility Connectivity**. Account status remains separate from connection evidence.

- **Recent connection:** a signed-in staff browser contacted the cloud in the last 3 minutes, or an active branch server contacted it in the last 15 minutes.
- **No recent connection:** an earlier contact exists, but neither window has a recent contact.
- **Not yet observed:** no qualifying contact has been recorded.
- **Unknown — stale view:** refresh failed or the displayed snapshot is over 90 seconds old. Previous timestamps remain visible; current counts are withheld.

The dashboard refreshes every 30 seconds while visible. Staff browsers report at most once per minute while visible and online. Closed tabs, sleeping computers and older app versions may not report. Multiple tabs sharing a login session count once. Sign-out can leave a session counted for up to 3 minutes. Contact is not proof of productive work or continuous connectivity.

## Deployment and access

Apply `supabase/migrations/20260911010000_add_facility_connectivity.sql` before deploying the frontend. Existing branch-server timestamps can appear immediately; browser observations accumulate after staff use the updated app. No historical browser presence is inferred from audit logs.

The database derives staff identity, session, organization and timestamp on the server. Inactive staff and anonymous callers cannot report. Only an active super admin can read the cross-facility summary. Browser clients have no direct table privileges. No patient details, IP addresses or device fingerprints are stored. A reporting user's contact rows older than 30 days are removed on their next report; there is no global scheduled retention job.

## Acceptance checks

1. Sign in as staff in a test facility and open a visible workspace. Confirm the super-admin dashboard records its contact and staff/session count.
2. Close that staff session, wait beyond 3 minutes, and refresh. Browser contact should no longer count as recent. A recently connected branch server can still keep the facility recent.
3. Confirm account status does not change with connection status.
4. Disconnect the viewing browser and refresh. Confirm the last observations are marked stale, not reported as current.
5. Verify another ordinary staff account cannot read the cross-facility summary.

Isolated PostgreSQL checks passed for organization attribution, super-admin-only summary access, denied anonymous/inactive reporting, denied direct table access and expiry of the browser contact window. Production acceptance remains pending deployment.
