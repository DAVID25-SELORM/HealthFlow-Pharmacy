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


describe('read-only branch connection check', () => {
  it('validates tenant and branch without changing stock or sending queued work', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-connection-'))
    const syncUrl = pathToFileURL(path.resolve('local-branch-server/src/supabaseSync.js')).href
    const dbUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { db, closeDatabase } = await import(${JSON.stringify(dbUrl)});
      const { validateCloudBranchSession } = await import(${JSON.stringify(syncUrl)});
      let branch = 'branch-test';
      let organization = 'org-test';
      let count = 0;
      globalThis.fetch = async (url, options) => {
        if (!String(url).endsWith('/rpc/branch_sync_get_inventory_snapshot')) throw new Error('Unexpected network write');
        const body = JSON.parse(options.body);
        if (body.p_limit !== 1 || body.p_sync_token !== 'test-sync-token') throw new Error('Unexpected query');
        count++;
        return new Response(JSON.stringify({ organization_id: organization, branch_id: branch }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const before = db.prepare('SELECT total_changes() AS count').get().count;
      const identity = await validateCloudBranchSession();
      let rejected = 0;
      for (const mismatch of ['branch', 'organization']) {
        branch = mismatch === 'branch' ? 'other' : 'branch-test';
        organization = mismatch === 'organization' ? 'other' : 'org-test';
        try { await validateCloudBranchSession(); } catch { rejected++; }
      }
      const changed = db.prepare('SELECT total_changes() AS count').get().count - before;
      closeDatabase();
      console.log(JSON.stringify({ identity, rejected, changed, count }));
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'), encoding: 'utf8',
        env: { ...process.env, HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite'), SUPABASE_URL: 'https://example.invalid', SUPABASE_SYNC_KEY: 'test-sync-key', BRANCH_SYNC_TOKEN: 'test-sync-token', ORGANIZATION_ID: 'org-test', BRANCH_ID: 'branch-test' },
      })
      expect(JSON.parse(output.trim().split(/\r?\n/).at(-1))).toEqual({ identity: { organizationId: 'org-test', branchId: 'branch-test' }, rejected: 2, changed: 0, count: 3 })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
