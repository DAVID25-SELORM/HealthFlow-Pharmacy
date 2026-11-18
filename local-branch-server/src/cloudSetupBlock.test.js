import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parseSetupBlock,
  SETUP_BLOCK_FIELDS,
  SetupBlockError,
  summarizeSetup,
} from './cloudSetupBlock.js'

// Made-up values in the same shape the cloud screen produces. None of these is a real credential.
const ORG = '3f2a9c1e-5b7d-4e8a-9c3b-1d2e4f6a8b0c'
const BRANCH = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718'
const NHIA = '0f9e8d7c6b5a49382716a5b4c3d2e1f00f9e8d7c6b5a4938'
const URL = 'https://example-project.supabase.co'
const KEY = 'sb_publishable_exampleexampleexample'

const screenBlock = (overrides = {}) => {
  const v = {
    NHIA_CONFIG_SECRET_KEY: NHIA,
    ORGANIZATION_ID: ORG,
    BRANCH_ID: BRANCH,
    BRANCH_SYNC_TOKEN: TOKEN,
    SUPABASE_URL: URL,
    SUPABASE_SYNC_KEY: KEY,
    HEALTHFLOW_UPDATE_MANIFEST_URL: '<your-signed-update-manifest-url>',
    HEALTHFLOW_UPDATE_PUBLIC_KEY: '<your-update-public-key-with-escaped-newlines>',
    ...overrides,
  }
  return [
    'PORT=4780',
    `NHIA_CONFIG_SECRET_KEY=${v.NHIA_CONFIG_SECRET_KEY}`,
    `ORGANIZATION_ID=${v.ORGANIZATION_ID}`,
    `BRANCH_ID=${v.BRANCH_ID}`,
    `BRANCH_SYNC_TOKEN=${v.BRANCH_SYNC_TOKEN}`,
    `SUPABASE_URL=${v.SUPABASE_URL}`,
    `SUPABASE_SYNC_KEY=${v.SUPABASE_SYNC_KEY}`,
    `HEALTHFLOW_UPDATE_MANIFEST_URL=${v.HEALTHFLOW_UPDATE_MANIFEST_URL}`,
    `HEALTHFLOW_UPDATE_PUBLIC_KEY=${v.HEALTHFLOW_UPDATE_PUBLIC_KEY}`,
    'HEALTHFLOW_UPDATE_AUTO_CHECK_HOURS=24',
    'HEALTHFLOW_UPDATE_AUTO_INSTALL=false',
  ].join('\n')
}

const EXPECTED = {
  organizationId: ORG,
  branchId: BRANCH,
  branchSyncToken: TOKEN,
  supabaseUrl: URL,
  supabaseSyncKey: KEY,
  nhiaConfigSecretKey: NHIA,
}

describe('cloud setup block', () => {
  it('picks the six connection values out of the block exactly as the cloud screen shows it', () => {
    expect(parseSetupBlock(screenBlock())).toEqual(EXPECTED)
  })

  it('ignores PORT, update settings and placeholders for settings it does not use', () => {
    // The update lines hold "<your-...>" placeholders; they are not needed and must not block setup.
    expect(() => parseSetupBlock(screenBlock())).not.toThrow()
    expect(Object.keys(parseSetupBlock(screenBlock()))).toHaveLength(6)
  })

  it('copes with Windows line endings, a byte-order mark, quotes, export, comments and blank lines', () => {
    const messy = `﻿# copied from the cloud\r\n\r\nexport ORGANIZATION_ID="${ORG}"\r\n  BRANCH_ID = '${BRANCH}'  \r\n` +
      `BRANCH_SYNC_TOKEN=${TOKEN}\r\nSUPABASE_URL=${URL}\r\nSUPABASE_SYNC_KEY=${KEY}\r\nNHIA_CONFIG_SECRET_KEY=${NHIA}\r\n\r\n`
    expect(parseSetupBlock(messy)).toEqual(EXPECTED)
  })

  it('uses the last value when a key appears twice', () => {
    const other = 'b1b2b3b4-c1c2-4d1d-8e1e-f1f2f3f4f5f6'
    expect(parseSetupBlock(`${screenBlock()}\nBRANCH_ID=${other}`).branchId).toBe(other)
  })

  it('does not mistake a longer key for a wanted one', () => {
    const text = `${screenBlock()}\nHEALTHFLOW_BRANCH_ID=ignored\nOLD_SUPABASE_URL=https://old.example.com`
    expect(parseSetupBlock(text)).toEqual(EXPECTED)
  })

  it('says what to do when the clipboard is empty', () => {
    for (const empty of ['', '   \r\n ', undefined, null]) {
      expect(() => parseSetupBlock(empty)).toThrow(SetupBlockError)
      expect(() => parseSetupBlock(empty)).toThrow(/press Copy/)
    }
  })

  it('names every missing key', () => {
    const text = `ORGANIZATION_ID=${ORG}\nBRANCH_ID=${BRANCH}`
    let error
    try {
      parseSetupBlock(text)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(SetupBlockError)
    for (const key of ['BRANCH_SYNC_TOKEN', 'SUPABASE_URL', 'SUPABASE_SYNC_KEY', 'NHIA_CONFIG_SECRET_KEY']) {
      expect(error.message).toContain(key)
    }
    expect(error.message).not.toContain('ORGANIZATION_ID,')
  })

  it('refuses the placeholders the cloud screen prints when it does not know the cloud address or key', () => {
    const text = screenBlock({
      SUPABASE_URL: '<your-healthflow-cloud-url>',
      SUPABASE_SYNC_KEY: '<your-supabase-anon-or-publishable-key>',
    })
    expect(() => parseSetupBlock(text)).toThrow(/placeholder.*SUPABASE_URL, SUPABASE_SYNC_KEY/)
  })

  it('never puts a token or key into the text that is shown back', () => {
    const shown = JSON.stringify(summarizeSetup(parseSetupBlock(screenBlock())))
    for (const secret of [TOKEN, KEY, NHIA]) expect(shown).not.toContain(secret)
    expect(shown).toContain(ORG)
    expect(shown).toContain('example-project.supabase.co')
  })

  it('stays in step with the block the cloud screen prints', () => {
    // If the screen ever stops printing one of these keys, the helper would silently stop working.
    // The screen, the Copy button and the downloaded setup file all build their text in this one module.
    const screen = fs.readFileSync(path.resolve('src/services/offlineSetupFile.js'), 'utf8')
    for (const key of Object.keys(SETUP_BLOCK_FIELDS)) {
      expect(screen).toContain(`${key}=\${`)
    }
  })
})

describe('Connect-To-HealthFlow-Cloud helper wiring', () => {
  const serverDir = path.resolve('local-branch-server')
  const read = (...parts) => fs.readFileSync(path.join(serverDir, ...parts), 'utf8')

  it('is launched elevated from a double-clickable command file', () => {
    const launcher = read('Connect-To-HealthFlow-Cloud.cmd')
    expect(launcher).toMatch(/-Verb RunAs/)
    expect(launcher).toContain('connect-to-cloud.ps1')
    expect(launcher).toMatch(/-Sta/)
  })

  it('saves through the same code as the app button, then restarts the service and checks health', () => {
    const script = read('scripts', 'connect-to-cloud.ps1')
    expect(script).toMatch(/#Requires -RunAsAdministrator/)
    expect(script).toContain('connect-to-cloud.mjs')
    expect(script).toContain('restart-service.ps1')
    expect(script).toContain('health-check.ps1')
    const helper = read('scripts', 'connect-to-cloud.mjs')
    expect(helper).toContain('saveCloudSyncSettings')
    expect(helper).toContain('parseSetupBlock')
  })

  it('never writes a secret to the screen', () => {
    const helper = read('scripts', 'connect-to-cloud.mjs')
    expect(helper).not.toMatch(/console\.(log|error)\([^)]*(branchSyncToken|supabaseSyncKey|nhiaConfigSecretKey)/)
  })

  it('is mentioned in the installer instructions', () => {
    const builder = read('scripts', 'build-offline-installer-package.ps1')
    expect(builder).toContain('Connect-To-HealthFlow-Cloud.cmd')
  })
})
