# Offline server connection and sign-in: impact report, 2026-11-25

Includes the protected baseline update for `src/context/AuthContext.jsx`. Offline (branch) server and the app it
serves. No database migration, no edge function.

## What was wrong

1. **The app was never told it was on an offline server.** The server serves the bundled files before its own
   `/branch-runtime-config.js` route, and the bundle holds an empty file of that name, so the route never ran (present
   since May 2026). A browser had no way in unless someone typed the server key into it.
2. **The route that never ran would have been unsafe.** It set a cookie holding `BRANCH_SERVER_TOKEN` for any request
   with a `Sec-Fetch-Site: same-origin` header, which any program can send. That key also signed staff sessions, so
   its holder could sign a session as any member of staff. Turning the route on as written was not acceptable.
3. **Setup opened the plain address**, which does not register the browser.
4. **A refresh signed offline staff out** (seen once the connection worked). While the page starts, before it knows who
   is signed in, it saves the default role `assistant`; the saved offline sign-in then looked like another role's.

## What changes

| Area | Before | After |
|---|---|---|
| Telling the app it is offline | Never happened | The real route comes before the static files. It carries no key |
| How a browser gets in | The server key | A registered computer's own id and secret (already issued by the installer, revocable one by one). The server key still works for the server's scripts and where an administrator typed it in |
| Cookie with the server key | Written in the code | Removed |
| Signing staff sessions | `BRANCH_SERVER_TOKEN` | A separate secret made on the server, `session-signing.key` beside the database. Not in backups, never sent |
| Unregistered browser | Failed without saying why | Says how to connect |
| Setup | Opens the plain address | Opens the "HealthFlow Offline POS" shortcut |
| Refresh while signed in offline | Signed out | Stays signed in |

## The protected file

| File | Fingerprint before | Fingerprint after |
|---|---|---|
| `src/context/AuthContext.jsx` | `bc9a4238845d4f0254f58f623197b2404da98def22740d4389c0dabe8f1c1249` | `37a7141f9f2511b233a596ca4151362a1d84bec5db7375809127c500b44b033a` |

The only edit: `storeActiveRole(offlineSession.role)` in `restoreOfflineAuth` and in `signInOffline`, before the
screens are shown. Both run only for an offline staff sign-in. Online sign-in, sign-out, role switching and profile
loading are not edited. With it, `getSavedOfflineStaffSession` (in `branchServerApi.js`) no longer compares the saved
role with the stored one when restoring; requests still do, it must still be unexpired and offline, and the server
verifies the signed session and the staff member's current role on every request.

Characterization tests added in `src/context/AuthContext.test.jsx`: restored after a refresh with the role saved before
the first screen asks for anything (fails on the code before this change), and not restored when expired or not an
offline sign-in. The other tests in that file are unchanged and pass.

## What people will notice

- Offline server users are signed out once after updating (sessions are signed with the new secret).
- On a registered computer the offline features now switch on by themselves: offline PIN sign-in, the Updates tab, and
  **the app prefers the offline server for its data whenever it can reach it, even with internet**. That is the
  designed behaviour, but in an installed app it has had little or no real use, because the connection never happened
  by itself. Check each daily task on a test computer.
- A browser that already has the server key typed in keeps working.
- The online website: the new notice and connection rules apply only to pages served by an offline server.

## What this does not protect against

- A computer's secret is saved in its browser and in its desktop shortcut, which other Windows users of that computer
  can read. It lets them reach the server as that computer; they still need a staff sign-in. Revoke a lost computer.
- Anyone who can read the server computer's data folder can read the database and the signing secret.
- Till staff can still read the patient and NHIS claim lists (see the role-rules change, #82).

## Checks

- `local-branch-server/src/offlineServerConnection.test.js` starts the real server as its own process: it says it is
  an offline server although the bundle holds the empty file; it gives out no key even with the forged header; an
  unregistered computer is refused; a registered one signs staff in by PIN without the server key; a session signed
  with the server key is refused; the secret is not in a backup; a revoked computer is shut out.
- A real browser against the real server on the installer's Node.js 22, with every other address blocked: an
  unregistered browser is told how to connect; administrator, cashier, pharmacist and claims officer register through
  the shortcut address, sign in by PIN, open every item in their menu with no role refusal, see the Updates tab and a
  test update (only the administrator gets Update now), and stay signed in after a refresh. The one failed request was
  the CC code policy lookup, which needs HealthFlow Cloud.

## Not proven

A real Windows install: HTTPS with the facility certificate, setup opening the shortcut, a second computer on the
network, completing a sale with an NHIS claim, and a real update. The Linux installer has not been looked at for
computer registration.

## Rollback

Revert the commit. The signing secret file can be left in place.
