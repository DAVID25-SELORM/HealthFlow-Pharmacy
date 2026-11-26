#!/usr/bin/env node
// Used by prepare-for-another-pharmacy.ps1. With --check it only counts what has not reached the cloud.
// It prints counts and folder names, never a record or a key.
import path from 'node:path'
import { archiveFacilityData, countUnsyncedRecords } from '../src/archiveFacilityData.js'

const args = process.argv.slice(2)
const rootAt = args.indexOf('--install-root')
const installRoot = rootAt >= 0 ? args[rootAt + 1] : ''
if (!installRoot) {
  console.error('Pass --install-root <folder>.')
  process.exit(1)
}

try {
  if (args.includes('--check')) {
    const unsynced = countUnsyncedRecords(path.join(installRoot, 'data', 'healthflow-branch.sqlite'))
    console.log(`Records that have not reached HealthFlow Cloud: ${unsynced}`)
    process.exit(unsynced > 0 ? 3 : 0)
  }
  const result = archiveFacilityData({ installRoot, allowUnsynced: args.includes('--allow-unsynced') })
  console.log(`Archived to: ${result.archiveDir}`)
  console.log(`Moved or copied: ${result.moved.join(', ')}`)
  if (result.unsynced) console.log(`Warning: ${result.unsynced} record(s) in the archive never reached the cloud.`)
} catch (error) {
  console.error(`NOT DONE: ${error.message}`)
  process.exit(2)
}
