# HealthFlow Backup and Recovery

## Recycle Bin is not a backup

HealthFlow archives deleted inventory items and NHIS claims in the
administrator **Recycle Bin** so accidental deletions can be restored. This is
short-term operational recovery, not disaster recovery. Continue scheduled
Supabase and Local Branch Server backups, and do not permanently delete an
archived record until retention requirements are satisfied.

## Database

Main SQLite file:

- Windows production: `C:\HealthFlowLocal\data\healthflow-branch.sqlite`
- Linux production: `/var/lib/healthflow-branch/healthflow-branch.sqlite`
- Development fallback: `local-branch-server/data/healthflow-branch.sqlite`

SQLite uses WAL mode, foreign keys, busy timeout, and startup integrity checks.

## Automatic Safeguards

- Startup runs `PRAGMA integrity_check`.
- Corrupt databases are preserved with a `-corrupt-` suffix and a fresh database is created.
- Inventory import creates a backup before replacing local inventory.
- Migrations run through `schema.sql` plus idempotent `ensureColumn` calls in `db.js`.

## Manual Backup

Stop the service first when possible.

Authenticated API backup:

```bash
curl -X POST http://127.0.0.1:4780/api/database/backup \
  -H "Content-Type: application/json" \
  -H "x-branch-token: YOUR_BRANCH_SERVER_TOKEN" \
  -d '{"label":"manual"}'
```

Windows:

```powershell
Stop-Service HealthFlowOfflineServer
Copy-Item C:\HealthFlowLocal\data\healthflow-branch.sqlite C:\HealthFlowLocal\data\backups\healthflow-branch-manual.sqlite
Start-Service HealthFlowOfflineServer
```

Linux:

```bash
sudo systemctl stop healthflow-branch
sudo mkdir -p /var/lib/healthflow-branch/backups
sudo cp /var/lib/healthflow-branch/healthflow-branch.sqlite /var/lib/healthflow-branch/backups/healthflow-branch-manual.sqlite
sudo systemctl start healthflow-branch
```

## Recommended Backup Schedule

- Daily local backup.
- Weekly off-machine backup.
- Backup before imports, version upgrades, facility migration, and sync repair.
- Keep at least 14 daily backups and 8 weekly backups.

## Recovery

1. Stop the branch server service.
2. Copy the selected backup into the production database path.
3. Preserve the failed database with a timestamp suffix.
4. Start the service.
5. Run the health check.
6. Open Settings or Sync diagnostics and confirm queue health.

## Integrity Checks

Run from `local-branch-server`:

```bash
node -e "import('./src/db.js').then(({ db }) => console.log(db.prepare('PRAGMA integrity_check').pluck().get()))"
```

Expected result: `ok`.

The branch server also exposes an authenticated database status endpoint:

```bash
curl http://127.0.0.1:4780/api/database/status -H "x-branch-token: YOUR_BRANCH_SERVER_TOKEN"
```
