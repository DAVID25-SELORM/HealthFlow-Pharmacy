# Offline update feed: how an update reaches installed PCs

Status: tooling built and tested in a Windows PowerShell 5.1 simulation (see "What was proven"). Not yet proven on a
real PC with the real Windows service. Nothing is published by building an update.

## How it works

1. Every installed offline server checks `HEALTHFLOW_UPDATE_MANIFEST_URL` every 24 hours (default
   `https://healthflowcloud.com/branch-updates/manifest.json`). The manifest names one version, its ZIP, its SHA-256
   and an Ed25519 signature. The server only trusts a manifest signed by the private key that matches the public key in
   its `.env` (`HEALTHFLOW_UPDATE_PUBLIC_KEY`, shipped in every installer).
2. If the manifest is newer than the installed version, the **Check for updates** result says so. Installing needs an
   administrator on that PC to press install, unless `HEALTHFLOW_UPDATE_AUTO_INSTALL=true` is set (off by default).
3. The server downloads the ZIP, verifies the hash, and starts `scripts/apply-update.ps1` through Windows (WMI) so the
   updater is not part of the service it stops. The updater stops the service, backs up the program files and the
   database, installs the new files, keeps `.env`, the data, the bundled Node.js and (unless the dependency list changed)
   `node_modules`, restarts the service and checks `/health` over HTTPS. If anything fails it restores the backup and
   restarts the old version (`rolled_back` in `updates/status.json`).

An update replaces only the server code and the bundled offline web app (`public`). It does not change settings,
data, certificates or the bundled Node.js. A change that needs a newer Node.js or a changed service setup still needs a
new installer.

The pharmacy's offline screens are the web app bundled in the server, not the live website, so website-only changes
reach an offline PC only through an update.

## First-update caveat

The updater that runs is the copy already installed on the PC. PCs installed before this tooling (installer 1.5.15 and
older) have an updater that cannot update a 1.5.x install (its health check uses plain HTTP and it needs a system npm).
Those PCs must be moved to installer 1.5.16 or newer once; from then on updates work. No pharmacy was running offline when
this was written, so only the test PC is affected.

## Releasing an update

1. Raise the version in `local-branch-server/package.json` and the two matching lines in `package-lock.json`.
2. Run the release script (private key stays outside the repository):

   ```powershell
   powershell -ExecutionPolicy Bypass -File local-branch-server\scripts\prepare-update-release.ps1 `
     -PrivateKeyPath "C:\secure\healthflow-update-private.pem" `
     -ReleaseNotes "What changed, in plain words" -Feed beta
   ```

   It rebuilds the offline web app, builds and signs the package, runs `verify-update-release.mjs` and, only if every
   check passes, copies the ZIP and `beta/manifest.json` into `public/branch-updates`.
3. Open a PR with those files. Merging deploys them to the website (this is the step that makes them reachable).
4. On the test PC, set `HEALTHFLOW_UPDATE_MANIFEST_URL=https://healthflowcloud.com/branch-updates/beta/manifest.json` in
   `C:\HealthFlowLocal\local-branch-server\.env`, restart the `HealthFlowOfflineServer` service, then check for updates
   and install. Confirm: version changed, sign-in works, data and sales are intact, sync works, `updates\status.json`
   says `installed`.
5. Release to everyone: `promote-update-feed.ps1`, PR, merge. PCs pick it up within 24 hours.
6. Put the test PC's `.env` back to the live manifest address.

## Rollback test (do once per updater change)

Publish a deliberately broken update to the beta feed only (for example a server file with a syntax error), install it on
the test PC and confirm the status ends as `rolled_back`, the old version serves again and the data is untouched.

## Where to look when an update does not install

- `C:\HealthFlowLocal\local-branch-server\updates\status.json`: last state and message.
- `C:\HealthFlowLocal\logs\update.log`: every step.
- `C:\HealthFlowLocal\backup-<time>\`: the copy taken before the update (program files and database). The two newest are
  kept.

## Keys

The private signing key must stay off facility PCs and out of the repository. Anyone holding it can push code to every
offline PC. If it is lost, no existing install can be updated: make a new pair with
`node local-branch-server\scripts\generate-update-keypair.mjs <folder>`, put the new public key in `.env.example`
(and `.env.linux.example`), and move every PC to a new installer.

## What was proven (simulation, Windows PowerShell 5.1)

A scratch install running the real branch server on the bundled Node.js 22 was updated by the real `apply-update.ps1`
with only the Windows service calls replaced by stand-ins (no administrator rights in that session):

- plain HTTP, dependencies unchanged: installed, new version serving, `.env`/data/Node.js/`node_modules` kept;
- HTTPS (the real facility-certificate setup), same result, health check passes over HTTPS;
- dependency list changed: `node_modules` reinstalled with the bundled npm and the server loads it;
- broken update: automatically rolled back and the old version serves again;
- the WMI launch: the updater is not a child of the service stand-in and survives its process tree being killed.

Still to prove on a real PC: the real Windows service stop/start by NSSM and the update started from inside the running
service.
