# Device-specific logout investigation

Status: local investigation and candidate fixes only. No push or deployment. The affected laptop/browser and timing have not been identified, and no logout trace from that device has been captured. Its exact root cause is therefore **not yet established**. The following are confirmed code findings, not a claim that every device is affected.

## Confirmed findings and impact

1. In `src/lib/supabase.js`, a non-auth API 401 enters `authRetryFetch` → `refreshSessionOnce`. Previously any refresh failure except 429 called `markAuthExpired`, dispatched `healthflow:supabase-auth-expired`, and caused AuthContext's expiry subscriber → `resetInvalidSession(preserveExistingSession:false)` → `clearSupabaseStoredSession`. A network error or auth-server 5xx at this point could destroy a recoverable session. The candidate fix dispatches expiry only for confirmed auth rejection/revocation or an absent session returned without error. Transient errors are surfaced without clearing storage; there is no new retry loop or expiry extension.
2. AuthContext previously used the same broad classifier for auth validation and application profile queries. It treated plain 403, any `AuthApiError`, and text mentioning refresh tokens as invalid authentication. A profile 403 at bootstrap could clear storage. The candidate classifier distinguishes application denial from auth-endpoint rejection and classifies 429/5xx/network failures first. Auth-endpoint 403 still follows the existing rejection policy; a profile/feature 403 does not.
3. Browser storage access could throw during idle bookkeeping, role preference restoration and diagnostic opt-in checks. Those paths now tolerate denied storage without changing Supabase's credential storage. The idle monitor retains its 30-minute deadline using in-memory activity bookkeeping if the activity preference cannot be read or written; this is not a new credential store.
4. Existing logout uses `supabase.auth.signOut()` without a scope. The installed SDK defaults to **global** scope. Manual logout or idle logout on another device can revoke the affected laptop's refresh session. This policy is unchanged. There is no app-enforced single-device login restriction found; production Supabase dashboard session policies were not inspected.

## Complete flow and state-clearing paths

| Path | Trigger and behavior |
| --- | --- |
| Login → SDK | `AuthContext.signIn` calls `signInWithPassword`; retries transient sign-in operations at most twice, deduplicates identical in-flight attempts, records activity after success. The SDK persists the session. |
| Initialization | AuthProvider starts with `loading:true`; queued bootstrap awaits `getSession`, whose SDK implementation waits for initialization. `onAuthStateChange` is scheduled outside the SDK callback and serialized. Resolution IDs reject stale completions. ProtectedRoute displays loading before deciding whether to redirect. |
| Missing session | BOOTSTRAP/INITIAL_SESSION/SIGNED_OUT recheck stored session. If none can be recovered, an eligible saved offline staff session is restored; otherwise in-memory auth state is cleared. Other temporary null auth events retain the current session. A failed storage read can still lead to a signed-out startup when there is no recoverable session; diagnostics now identify the failure. |
| Near expiry | AuthContext refresh window is 30 seconds; function calls use 60 seconds; user reads use 30 seconds. Refresh requests are coalesced. Valid fallback/race sessions remain subject to existing expiry checks. SDK retries and revocation handling are unchanged. |
| Auth validation | Sessions without expiry metadata run `getUser`; authentication rejection attempts refresh and revalidation, then `resetInvalidSession`. Existing stored-session preservation rules remain. |
| Invalid-session reset | Explicit auth-expired events disable preservation; otherwise existing session preservation is attempted. Removes the Supabase session, PKCE verifier and user keys from local/session storage and clears cached auth. It does not clear all browser storage. |
| SDK removal | Installed `@supabase/auth-js` removes saved sessions for invalid stored sessions and non-retryable refresh errors, then emits SIGNED_OUT. Retryable refresh-fetch errors are not removed by its refresh handler. Other-tab events are distributed through BroadcastChannel. No application `removeSession()` implementation was found. |
| Profile disabled | `profile.is_active === false` clears app state and calls SDK signOut. Unchanged. Staff-admin also bans/unbans auth accounts when staff activation changes. |
| Manual logout | TopBar, customer page and the suspended-workspace sign-out button call AuthContext.signOut. Clears the separate local branch user session, calls cloud signOut (global), and clears caches. Offline staff logout clears local auth state without cloud signOut. |
| Password recovery | Recovery token verification / existing PKCE session can bypass ordinary profile loading to allow password update. After a successful password update, Login explicitly signs out and redirects to `/login`; now logged as PASSWORD_CHANGED. |
| Idle logout | 30 minutes without pointerdown, keydown, touchstart or scroll. Activity is shared between tabs by a per-user localStorage timestamp. Visibility restoration checks elapsed time. Invokes global signOut; if the request fails it clears saved cloud/local session data and app state anyway. Now logged as IDLE_TIMEOUT. This policy is unchanged, including its use of wall time. |
| Profile/workspace error | Ordinary failures retain the session. The candidate UI displays a retryable workspace-loading error instead of rendering protected content with an unavailable profile or organization. A missing profile is distinguishable from a disabled profile. |
| Organization paused | Suspended/cancelled organization or billing status displays Access Paused; does not automatically sign out. Only the button does. |
| Offline transition | No online/offline listener calls global signOut. Connectivity chooses local/cloud routes. Saved branch staff sessions have their own token, expiry and role validation. Cloud and offline authentication remain distinct. |
| Deployment recovery | The asset-recovery script tracks a reload cooldown and reloads assets. It does not clear Supabase auth storage. |

## Persistence configuration

`src/lib/supabase.js` retains `persistSession:true`, `autoRefreshToken:true`, `detectSessionInUrl:true`, `flowType:'pkce'`, a stable `sb-<provider-project-ref>-auth-token` key, and the existing Navigator LockManager lock. There is no custom credential storage provider. Inspection of the installed SDK confirms localStorage is used when supported; its existing fallback is memory when localStorage is unavailable. That fallback cannot survive a browser restart. No switch to cookies/sessionStorage/new credential fields was introduced.

Repository auth configuration sets JWT lifetime to 3600 seconds and enables refresh-token rotation. Its timebox and server inactivity examples are commented out. This does not verify the actual hosted dashboard configuration. Token expiry, server validation, refresh rotation, global logout scope and disabled-user policy were not relaxed.

## API error classification

Ordinary tier-access/activity-log 400 and 500 responses did not directly call signOut before this change and still do not. They surface as application failures. The dangerous indirect path was a 401 followed by a transient refresh failure. Plain application 403 now remains an access-denied result. Invalid JWT, expired-session, revoked/missing refresh token and genuine auth-endpoint rejection remain authentication failures. Going offline or encountering a timeout does not prove revocation.

## Safe diagnostic collection

Diagnostics are opt-in, controlled by `VITE_HEALTHFLOW_AUTH_DIAGNOSTICS=true` or the existing per-browser flag `healthflow_auth_diagnostics=true`. For a local candidate build, enable this in that browser and reload. If localStorage itself is denied, use the build-time flag for the diagnostic build instead; no production build has been deployed here.

Only predefined metadata is retained. Error messages, payloads, user/organization/branch identifiers and secret fields are redacted. Session logs contain only presence, expiry timestamp, local time, expiry delta, online state and storage/cookie availability. Temporary probe keys/cookies contain `1` and are removed. No tokens or credentials are placed in diagnostic storage.

| Suspected failure | Evidence to collect |
| --- | --- |
| A: never persisted | LOGIN_SUCCESS/SIGNED_IN has a session but localStorageSessionPresent is false; inspect localStorageAvailable. |
| B: removed later | Storage presence changes from true to false, STORAGE_REMOVED from another tab, or an auth.storage.clear reason. Same-tab SDK removal is observed on its subsequent auth event; diagnostics do not intercept browser storage writes. Browser shutdown deletion requires comparing before/after observations. |
| C: refresh failure | auth.refresh / timed refresh operation failureCategory; distinguish REFRESH_REVOKED, SERVER_ERROR, NETWORK_UNAVAILABLE, NETWORK_TIMEOUT, RATE_LIMITED. |
| D: access expiry | expiresAt and secondsUntilExpiry compared to localTime; TOKEN_REFRESHED identifies success. |
| E: API/profile failure | auth.profile.failed category and retryable workspace error; transport regression tests verify no expiry event for API 400/403/500. |
| F: connectivity | auth.connectivity online:false before failure; no corresponding forced logout unless idle policy or genuine revocation also occurs. |
| G: storage denied | localStorageAvailable/sessionStorageAvailable/cookiesAvailable booleans, STORAGE_UNAVAILABLE. Diagnostics cannot read browser privacy policy or determine which extension deleted data. |
| H: clock skew | auth.clock compares local request/response midpoint to the server Date header; flags over two minutes. Missing/CORS-hidden Date is explicitly unavailable. Network delay and second-resolution Date limit precision. No automatic clock correction or expiry adjustment is made. |
| I: concurrent sessions | SIGNED_OUT/REFRESH_REVOKED plus timing of another device's MANUAL_LOGOUT/IDLE_TIMEOUT or administrator revocation. SDK events alone cannot identify who revoked a session. Check hosted session policy and auth logs. |
| J: invalid staff/workspace | PROFILE_DISABLED, PROFILE_MISSING or ORGANIZATION_UNAVAILABLE; compare staff-admin/account changes and paused-workspace UI. |

Laptop checks: identify the affected browser/profile and elapsed time; check automatic Windows date/time synchronization; compare the same application origin before and after restart; inspect private browsing, clear-on-exit, site-storage permissions and privacy extensions; compare logout timing with other devices and staff/account changes. These are investigative checks, not confirmed environmental causes. Do not share authorization headers, tokens, passwords, full HAR exports, or patient information; use only the safe auth diagnostics.

## Verification limits

Tests exercise actual installed SDK login persistence and restoration into fresh clients, AuthContext bootstrap/refresh/disabled-user policy, API failure isolation, offline events, storage denial, idle timing, diagnostic redaction, clock metadata and protected-route loading errors. Fresh SDK clients model application restarts with retained storage; they are not a physical close/reopen test of the reported laptop or its browser privacy settings. No live user was signed out, browser closed, or global policy changed for testing.

Validation: 46 test files / 215 tests passed across auth, AuthContext, protected routes, tier-access, branch API/connectivity and all contract tests. Source lint (`npm run lint -- --ignore-pattern 'output/**' --ignore-pattern 'tmp/**'`) and the final changed-file lint pass both exited 0. The final production build exited 0, with plugin timing warnings. Migration checks passed for 110 files; whitespace checks passed.

Raw `npm run lint` failed with 2,304 errors from pre-existing untracked generated output. The source lint run above excludes those artifacts. `protect:baseline` failed: AuthContext, NHIS service and tier-access working files differ from the recorded hashes. A separate comparison of committed HEAD confirmed baseline drift already existed before this investigation, including AuthContext; this candidate intentionally also edits AuthContext. The manifest is left unchanged for review rather than accepting unrelated drift. The investigation was initially completed locally against `9ebcdb3`; the user subsequently authorized pushing all updates. Live laptop verification remains outstanding.
