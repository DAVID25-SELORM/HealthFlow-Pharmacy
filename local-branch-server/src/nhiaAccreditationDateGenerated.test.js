// @vitest-environment node
// Offline persistence and sync of the accreditation generated/issue date.
// The value is an independent stored field: it must survive restart, a pre-migration
// database, sync upload/download and merges, and it is never derived from expiry/effective.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href

const run = (dbPath, body) => {
  const script = `
    const repo = await import(${JSON.stringify(repositoryUrl)});
    const { db, closeDatabase } = await import(${JSON.stringify(databaseUrl)});
    const out = {};
    const settings = () => { const s = repo.getNhiaSettings(); return { generated: s?.accreditationDateGenerated ?? null, expiry: s?.accreditationExpiryDate ?? null }; };
    const outbox = () => db.prepare("SELECT status, payload_json FROM sync_outbox WHERE entity_type = 'nhia_configuration' ORDER BY created_at, rowid").all()
      .map((row) => ({ status: row.status, config: JSON.parse(row.payload_json).config }));
    const base = { mode: 'OFFLINE_LOCAL', integrationMode: 'claimit_export', providerId: '03-05-00001', credentialCode: '03-05-001-02-00001-11-P1-2-011225',
      claimsOfficerName: 'Officer', accreditationExpiryDate: '2027-12-01', facilityType: 'Pharmacy' };
    ${body}
    closeDatabase();
    console.log('RESULT ' + JSON.stringify(out));
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: path.resolve('local-branch-server'),
    env: { ...process.env, HEALTHFLOW_DB_PATH: dbPath },
    encoding: 'utf8',
  })
  return JSON.parse(output.split(/\r?\n/).find((line) => line.startsWith('RESULT ')).slice(7))
}

describe('offline branch accreditation generated/issue date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-accred-'))
  const dbPath = path.join(dir, 'branch.sqlite')

  it('stores the three West Point dates independently and never derives one from another', () => {
    const out = run(dbPath, `
      repo.saveNhiaSettings({ ...base, accreditationDateGenerated: '2025-12-29' });
      out.saved = settings();
      out.uploadPayload = outbox().at(-1).config;
    `)
    expect(out.saved).toEqual({ generated: '2025-12-29', expiry: '2027-12-01' })
    // effective (2025-12-01) is in the credential code, generated (2025-12-29) and expiry (2027-12-01) are stored
    expect(out.uploadPayload.accreditation_date_generated).toBe('2025-12-29')
    expect(out.uploadPayload.accreditation_expiry_date).toBe('2027-12-01')
    expect(out.uploadPayload.credential_code).toContain('011225')
  })

  it('persists across a local restart (new process, same database)', () => {
    expect(run(dbPath, 'out.after = settings();').after).toEqual({ generated: '2025-12-29', expiry: '2027-12-01' })
  })

  it('does not wipe the value when an older client saves without the field, but honours an explicit clear', () => {
    const out = run(dbPath, `
      repo.saveNhiaSettings({ ...base, accreditationExpiryDate: '2028-01-01' });
      out.omitted = settings();
      repo.saveNhiaSettings({ ...base, accreditationExpiryDate: '2028-01-01', accreditationDateGenerated: '' });
      out.cleared = settings();
      repo.saveNhiaSettings({ ...base, accreditationDateGenerated: '2025-12-29' });
      out.restored = settings();
    `)
    expect(out.omitted).toEqual({ generated: '2025-12-29', expiry: '2028-01-01' })
    expect(out.cleared.generated).toBe('')
    expect(out.restored.generated).toBe('2025-12-29')
  })

  it('never falls back to expiry or effective date when the field is absent', () => {
    const fresh = path.join(dir, 'fresh.sqlite')
    const out = run(fresh, `
      repo.saveNhiaSettings({ ...base, accreditationExpiryDate: '2027-08-01' });
      out.settings = settings();
      out.row = db.prepare('SELECT accreditation_date_generated AS g FROM nhia_configuration').get();
      out.upload = outbox().at(-1).config.accreditation_date_generated ?? null;
    `)
    expect(out.settings).toEqual({ generated: '', expiry: '2027-08-01' })
    expect(out.row.g).toBeNull()
    expect(out.upload).toBeNull()
  })

  it('sync download merges: the cloud value wins, a blank cloud value keeps the local value, a pending local edit wins', () => {
    const merge = path.join(dir, 'merge.sqlite')
    const out = run(merge, `
      repo.saveNhiaSettings({ ...base, accreditationDateGenerated: '2025-12-29' });
      const id = db.prepare('SELECT id, organization_id, branch_id FROM nhia_configuration').get();
      db.prepare("UPDATE sync_outbox SET status = 'synced' WHERE entity_type = 'nhia_configuration'").run();
      const remote = (extra) => ({ id: id.id, organization_id: id.organization_id, branch_id: id.branch_id, mode: 'OFFLINE_LOCAL', facility_code: base.credentialCode,
        credential_code: base.credentialCode, provider_id: base.providerId, accreditation_expiry_date: '2027-12-01', is_active: true, ...extra });
      repo.importNhiaConfigurationSnapshot([remote({})]);
      out.blankCloud = settings();
      repo.importNhiaConfigurationSnapshot([remote({ accreditation_date_generated: '2025-12-30' })]);
      out.cloudWins = settings();
      repo.saveNhiaSettings({ ...base, accreditationDateGenerated: '2026-01-05' });
      repo.importNhiaConfigurationSnapshot([remote({ accreditation_date_generated: '2025-12-30' })]);
      out.pendingLocalWins = settings();
    `)
    expect(out.blankCloud.generated).toBe('2025-12-29')
    expect(out.cloudWins.generated).toBe('2025-12-30')
    expect(out.pendingLocalWins.generated).toBe('2026-01-05')
  })

  it('adds the column to a pre-migration database without touching existing data', () => {
    const legacy = path.join(dir, 'legacy.sqlite')
    run(legacy, "repo.saveNhiaSettings({ ...base, accreditationDateGenerated: '2025-12-29' });")
    const Database = execFileSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const d = new DatabaseSync(${JSON.stringify(legacy)});
      d.exec('ALTER TABLE nhia_configuration DROP COLUMN accreditation_date_generated');
      console.log('COLUMNS ' + d.prepare('pragma table_info(nhia_configuration)').all().map((c) => c.name).includes('accreditation_date_generated'));
      d.close();
    `], { encoding: 'utf8' })
    expect(Database).toContain('COLUMNS false')
    const out = run(legacy, `
      out.columns = db.prepare('pragma table_info(nhia_configuration)').all().map((c) => c.name).includes('accreditation_date_generated');
      out.settings = settings();
      repo.saveNhiaSettings({ ...base, accreditationDateGenerated: '2025-12-29' });
      out.after = settings();
    `)
    expect(out.columns).toBe(true)
    expect(out.settings).toEqual({ generated: '', expiry: '2027-12-01' }) // never backfilled or guessed
    expect(out.after.generated).toBe('2025-12-29')
  })

  it('upload payload keeps all three dates independent for the cloud sync function', () => {
    const out = run(path.join(dir, 'upload.sqlite'), `
      repo.saveNhiaSettings({ ...base, credentialCode: '03-05-001-02-00001-11-P1-2-011025', accreditationExpiryDate: '2027-08-01', accreditationDateGenerated: '2027-08-01' });
      out.payload = outbox().at(-1).config;
    `)
    // Suspicious equality is stored exactly as entered (a warning is the UI's job), not "corrected".
    expect(out.payload.accreditation_date_generated).toBe('2027-08-01')
    expect(out.payload.accreditation_expiry_date).toBe('2027-08-01')
  })
})
