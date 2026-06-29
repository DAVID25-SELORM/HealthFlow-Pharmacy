import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('offline NHIA tariff catalog', () => {
  it('imports and filters facility tariff rows without adding them to the outbox', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-tariffs-'))
    const repositoryUrl = pathToFileURL(
      path.resolve('local-branch-server/src/offlineRecordsRepository.js')
    ).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { closeDatabase, db } = await import(${JSON.stringify(databaseUrl)});
      const { importOfflineRecords, listOfflineRecords } = await import(${JSON.stringify(repositoryUrl)});
      const rows = [
        {
          id: 'private-exclusive',
          tariff_version: 'FEB 2023',
          facility_group: 'Private Primary Care Hospital',
          catering_option: 'exclusive',
          gdrg_code: 'OPDC01A',
          tariff_amount: 37.08,
          is_active: true
        },
        {
          id: 'chag-exclusive',
          tariff_version: 'FEB 2023',
          facility_group: 'CHAG Primary Care Hospital',
          catering_option: 'exclusive',
          gdrg_code: 'OPDC01A',
          tariff_amount: 35,
          is_active: true
        }
      ];
      importOfflineRecords('nhia_tariff_items', rows);
      const tariffs = listOfflineRecords('nhia_tariff_items', {
        tariff_version: 'FEB 2023',
        facility_group: 'Private Primary Care Hospital',
        catering_option: 'exclusive',
        limit: 5000
      });
      const outboxCount = db.prepare(
        "SELECT COUNT(*) AS count FROM sync_outbox WHERE entity_type = 'nhia_tariff_items'"
      ).get().count;
      closeDatabase();
      console.log(JSON.stringify({ tariffs, outboxCount }));
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

      expect(result.tariffs).toHaveLength(1)
      expect(result.tariffs[0]).toMatchObject({
        id: 'private-exclusive',
        facility_group: 'Private Primary Care Hospital',
        tariff_amount: 37.08,
      })
      expect(result.outboxCount).toBe(0)
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })
})
