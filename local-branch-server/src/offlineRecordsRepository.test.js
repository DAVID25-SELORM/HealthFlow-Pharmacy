import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('offline record outbox coalescing', () => {
  it('keeps one pending upsert with the latest local record payload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-record-outbox-'))
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const recordsUrl = pathToFileURL(path.resolve('local-branch-server/src/offlineRecordsRepository.js')).href
    const script = `
      const { db, closeDatabase, parseJson } = await import(${JSON.stringify(databaseUrl)});
      const { saveOfflineRecord } = await import(${JSON.stringify(recordsUrl)});
      saveOfflineRecord('patients', { id: 'patient-1', full_name: 'Before' });
      saveOfflineRecord('patients', { id: 'patient-1', full_name: 'After' });
      const rows = db.prepare("SELECT payload_json FROM sync_outbox WHERE entity_type = 'patients' AND entity_id = 'patient-1' AND event_type = 'record.upsert'").all();
      console.log(JSON.stringify({ count: rows.length, name: parseJson(rows[0].payload_json).record.full_name }));
      closeDatabase();
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: { ...process.env, HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite') },
        encoding: 'utf8',
      })
      expect(JSON.parse(output.trim().split(/\r?\n/).at(-1))).toEqual({ count: 1, name: 'After' })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not retrospectively deduct an already served claim when the local policy is enabled', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-nhis-inventory-'))
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const recordsUrl = pathToFileURL(path.resolve('local-branch-server/src/offlineRecordsRepository.js')).href
    const script = `
      const { db, closeDatabase, setBranchMeta, parseJson } = await import(${JSON.stringify(databaseUrl)});
      const { saveOfflineRecord, importOfflineRecords, getOfflineRecord, queueNhisServingSync, reconcileLocalNhisInventoryPolicyBaseline } = await import(${JSON.stringify(recordsUrl)});
      saveOfflineRecord('nhis_claims', { id: 'draft-ccc', status: 'draft', ccc_no: '', prescription_file_path: 'fixture.pdf' });
      const before = db.prepare('SELECT COUNT(*) FROM sync_outbox').pluck().get();
      let rejected = 0;
      try { saveOfflineRecord('nhis_claims', { id: 'draft-ccc', status: 'served', ccc_no: '' }); } catch (error) { if (error.code === 'NHIS_CCC_REQUIRED') rejected++; else throw error; }
      try { queueNhisServingSync({ id: 'draft-ccc', ccc_no: '' }); } catch (error) { if (error.code === 'NHIS_CCC_REQUIRED') rejected++; else throw error; }
      if (rejected !== 2 || db.prepare('SELECT COUNT(*) FROM sync_outbox').pluck().get() !== before) throw new Error('Invalid CCC changed offline outbox');
      const initial = { id: 'claim-1', ccc_no: '12345', updated_at: '2026-09-07T10:00:00.000Z', nhis_claim_medicines: [{ drug_code: 'NHIS-1', duration: '2 weeks', served_qty: 3 }] };
      importOfflineRecords('nhis_claims', [initial]);
      const snapshot = getOfflineRecord('nhis_claims', initial.id);
      if (snapshot.nhis_claim_medicines[0].duration !== '2 weeks') throw new Error('Snapshot lost duration');
      snapshot.nhis_claim_medicines[0].dose = '1';
      saveOfflineRecord('nhis_claims', snapshot);
      const saved = parseJson(db.prepare("SELECT payload_json FROM sync_outbox WHERE entity_id = 'claim-1' AND event_type = 'record.upsert'").get().payload_json).record;
      if (saved.nhis_claim_medicines[0].duration !== '2 weeks') throw new Error('Duration lost in outbox');
      let durationRejected = false;
      try { saveOfflineRecord('nhis_claims', { ...initial, nhis_claim_medicines: [{ ...initial.nhis_claim_medicines[0], duration: '' }] }); } catch (error) { if (error.code === 'NHIS_DURATION_REQUIRED') durationRejected = true; else throw error; }
      if (!durationRejected) throw new Error('Missing duration reached offline outbox');
      db.prepare("INSERT INTO drugs (id, name, quantity, price, nhis_code, updated_at) VALUES ('drug-1', 'Test', 10, 1, 'NHIS-1', '2026-09-07T10:00:00.000Z')").run();
      setBranchMeta('pharmacy_settings_snapshot', JSON.stringify([{ nhis_deduct_inventory_on_serve: true }]));
      reconcileLocalNhisInventoryPolicyBaseline();
      queueNhisServingSync(initial);
      const next = { ...initial, updated_at: '2026-09-07T10:01:00.000Z', nhis_claim_medicines: [{ drug_code: 'NHIS-1', duration: '2 weeks', served_qty: 5 }] };
      queueNhisServingSync(next);
      const quantity = db.prepare("SELECT quantity FROM drugs WHERE id = 'drug-1'").pluck().get();
      const ledger = db.prepare('SELECT COALESCE(SUM(-quantity_delta), 0) FROM local_nhis_inventory_ledger').pluck().get();
      console.log(JSON.stringify({ quantity, ledger }));
      closeDatabase();
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: { ...process.env, HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite') },
        encoding: 'utf8',
      })
      expect(JSON.parse(output.trim().split(/\r?\n/).at(-1))).toEqual({ quantity: 8, ledger: 2 })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
