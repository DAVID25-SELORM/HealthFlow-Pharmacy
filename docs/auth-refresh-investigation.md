# Refresh-token failure investigation ? 11 September 2026

## Conclusion and evidence limits

Production response confirmed by the user: `refresh_token_not_found`, message `Invalid Refresh Token: Refresh Token Not Found`. Tier-access returned `You must be signed in to continue.` Supabase did not recognize the submitted refresh token. This is a terminal failure requiring a new sign-in. The evidence does not establish why that token became unavailable. A production rotation race, storage corruption, clock-skew cause or multi-device revocation is not proven.

Two reproducible code risks were found and corrected locally: overlapping function-401 retry layers, and conversion of transient refresh errors into session-expired errors. These are code defects; attributing this particular laptop incident to them requires production evidence.

## Exact flow and owners

- `src/lib/supabase.js`: singleton `createClient`, `persistSession: true`, `autoRefreshToken: true`, PKCE, provider-derived `sb-<project-ref>-auth-token` storage key. No custom token store or second staff Supabase client was found in source. SDK localStorage persistence remains unchanged.
- `getValidFunctionSession` checks access expiry within 60 seconds; `getValidUserSession` uses 30 seconds. `getCurrentAuthSession` can call SDK `getSession`, which itself may refresh.
- `refreshSupabaseSessionOnce` is the sole application call to SDK `auth.refreshSession()` and shares one in-flight promise in this JS instance. AuthContext also calls this helper via `refreshStoredSession`.
- `authRetryFetch` formerly refreshed any non-auth 401 and retried. `invokeSupabaseFunction` could see its final 401, call another refresh and retry again. Function wrappers now own that one recovery; REST keeps transport recovery. Customer e-pharmacy's direct SDK invocation retains its existing transport recovery.
- `recoverRejectedFunctionSession` shares refresh work, reuses an already renewed cached token, propagates transient errors unchanged, and marks terminal failures. It does not retry a rejected access token as recovery.
- `markAuthExpired` clears the in-memory cache and dispatches `healthflow:supabase-auth-expired`. Repeated concurrent terminal results now dispatch once while expired.
- `src/context/AuthContext.jsx`: `subscribeSupabaseAuthExpired` enqueues `resetInvalidSession` with `preserveExistingSession: false`. This is the source of ?Clearing invalid HealthFlow Cloud session.? It calls `clearSupabaseStoredSession`, then attempts `restoreOfflineAuth`, otherwise `clearAuthState`.
- `clearSupabaseStoredSession` removes the cloud storage key and its code-verifier/user companions from localStorage and sessionStorage. Offline server session storage uses separate keys.
- SDK `node_modules/@supabase/auth-js/src/GoTrueClient.ts`: `_callRefreshToken` calls `_refreshAccessToken`, saves the new session, and emits `TOKEN_REFRESHED`. Non-retryable auth errors call `_removeSession`, deleting SDK storage and broadcasting `SIGNED_OUT`. Therefore SDK removal can precede application cleanup, even for an unrecognized non-retryable 400.
- `src/components/Auth/ProtectedRoute.jsx`: absent user causes `<Navigate to="/login" replace />`.
- AuthContext manual/idle logout invokes SDK `signOut()` with its default scope. Disabled-profile handling also signs out. These paths remain unchanged. The observed invalid-session cleanup does not itself call remote `signOut`.

## Rotation, concurrency and storage

Repository `supabase/config.toml` enables refresh rotation, 10-second reuse interval and 3600-second access-token expiry. These repository values are not verification of hosted production configuration. Supabase documents reuse exceptions and configurable single-session policy at https://supabase.com/docs/guides/auth/sessions.

The installed SDK's `refreshSession()` acquires the auth storage lock, reads session state under that lock, and `_callRefreshToken` has `refreshingDeferred` deduplication. Automatic refresh uses the same lock. HealthFlow's `waitForSupabaseAuthLock` uses Navigator Locks when available; without them it executes the operation directly. Its lock acquisition ignores the SDK timeout and waits. Thus automatic/manual refresh can be requested concurrently but are normally serialized on supported browsers. Sequential unnecessary rotations were possible through layered retries; sending the same old refresh token twice across real windows was not reproduced.

BroadcastChannel is used by the SDK for cross-tab auth events. Different origins/profiles have separate stores/locks. No application `auth.setSession()` or competing direct refresh call was found. React `setSession()` calls update React state, not Supabase persistence. No production `localStorage.clear()` was found; test files use it. Branch-server cleanup targets its own keys. Storage-write failure/corruption on the affected device remains unverified. Existing optional storage diagnostics test writes using harmless probe keys and report only presence/availability.

## Why tier-access returned 401

`supabase/functions/tier-access/index.ts` authorization rejects a missing header and rejects a failed `userClient.auth.getUser()`. The client supplies Bearer authorization through `invokeFunctionWithToken`. Expired/stale/revoked/malformed tokens or gateway JWT validation could all explain 401; the reported sequence does not distinguish them. No NHIS-specific change was made.

## Safe diagnostics

`logRefreshResponse` in `src/utils/authDiagnostics.js` observes the refresh response for SDK automatic and custom refresh alike through the existing global fetch hook. It does not read request bodies, tokens, headers or successful response bodies. It reports HTTP status, known provider error code, exact allowlisted provider message, cached expiry (nullable on bootstrap), attempt time, browser family, connectivity and reason code. Unknown codes/messages are withheld, never emitted verbatim. No SDK debug logging is enabled (its debug source includes token fragments).

Diagnostics remain opt-in through existing `VITE_HEALTHFLOW_AUTH_DIAGNOSTICS` or local `healthflow_auth_diagnostics=true` preference. No production setting has been changed. Existing forced-logout and storage-clear categories remain; the new refresh record distinguishes AUTH_REFRESH_INVALID, AUTH_REFRESH_REVOKED and AUTH_SESSION_EXPIRED where the provider supplies recognized codes. SDK-only unknown errors remain AUTH_REFRESH_FAILED, not a guessed revocation. Raw provider evidence must be read locally if not allowlisted.

## Clock and revocation

On this workspace computer, `w32tm /query /status` returned ?service has not been started?; timezone is Greenwich Standard Time. This is not evidence that the affected laptop clock is wrong, or even the same computer. Existing `logAuthServerClock` compares an exposed auth Date header with the request midpoint and reports skew above 2 minutes. Actual failing-request server time has not been captured.

Staff-admin updates use `updateUserById` with ban settings for disabled users. Password/security operations and default-scope signOut are possible revocation sources. A role edit or login elsewhere is not assumed to revoke a session. Hosted single-session/timebox settings and provider audit logs remain unverified.

## Tests and remaining device matrix

Focused mocked-SDK tests cover successful refresh, invalid/reused refresh rejection, concurrent failed requests sharing one refresh/one expiration event, 401 retry limit, 429/503/network failure preservation, auth persistence/locking characterization, AuthContext behavior, clock diagnostics and secret redaction. These do not substitute for physical multi-tab or sleep/wake testing.

Pending on the affected laptop: one tab; two tabs; separate windows; background/sleep; OS sleep/wake; browser restart; real access expiry; temporary outage/reconnection; revoked-token test using a disposable account. Capture response error fields and safe diagnostic timestamps. Do not revoke a real staff session or change laptop network/time settings merely to simulate failure. Validate hosted reuse/single-session settings read-only. Invalid cloud state and existing offline PIN restoration remain separate; offline authorization and token lifetime have not been weakened.

User authorized pushing these auth fixes after supplying the production error. Facility-connectivity changes were delivered separately. A repository push does not establish live deployment or resolution on the affected device.

## Validation result

The focused six-file auth run passed 61 tests. After retaining direct customer-function recovery, the two recovery suites passed 15 tests. Lint and protected-baseline validation passed; production build passed in 15.41 seconds. Real device acceptance and underlying token-invalidity cause remain pending. No claim of a production root-cause resolution is made.

## Release scope

The confirmed refresh response is terminal, so secure logout remains. The release removes duplicate function recovery, preserves transient failures, deduplicates concurrent expiry events, and adds opt-in safe diagnostics. It does not recover revoked/missing tokens or prove the device-specific cause resolved.

Final pre-push validation: all 64 tests across six auth suites passed, including concurrent successful renewal, concurrent terminal rejection, transient failure preservation and direct customer recovery. Lint and the protected baseline passed.
