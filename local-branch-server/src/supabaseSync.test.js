import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('offline sync status reconciliation', () => {
  it('clears a failed record when its outbox event already synced', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-sync-'))
    const syncUrl = pathToFileURL(path.resolve('local-branch-server/src/supabaseSync.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { db, closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const { reconcileSyncedOfflineRecordStatuses } = await import(${JSON.stringify(syncUrl)});
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO offline_records (id, entity_type, data_json, sync_status, last_sync_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run('drug-local', 'nhis_drugs', '{}', 'failed', 'old RLS error', now, now);
      db.prepare(
        'INSERT INTO sync_outbox (id, event_type, entity_type, entity_id, payload_json, status, created_at, updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run('event-1', 'record.upsert', 'nhis_drugs', 'drug-local', '{}', 'synced', now, now, now);
      const changes = reconcileSyncedOfflineRecordStatuses();
      const record = db.prepare(
        'SELECT sync_status, last_sync_error, synced_at FROM offline_records WHERE id = ? AND entity_type = ?'
      ).get('drug-local', 'nhis_drugs');
      closeDatabase();
      console.log(JSON.stringify({ changes, record }));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.changes).toBe(1)
      expect(result.record).toEqual({
        sync_status: 'synced',
        last_sync_error: null,
        synced_at: expect.any(String),
      })
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })
})
