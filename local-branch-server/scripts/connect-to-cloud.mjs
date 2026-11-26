#!/usr/bin/env node
// Reads a Branch Sync Setup block on standard input and saves the cloud connection into this server's
// .env, using the same function (saveCloudSyncSettings) the app's "Apply facility connection" button uses.
// It prints ids and the cloud address only, never a token or key.
//
// With --check it only proves the block is usable: it runs the same validation against a throwaway
// file and never touches the real .env (used before installing, so a bad block is caught up front).
//
// Exit codes: 0 saved (or, with --check, usable), 2 the block was not usable (nothing was changed),
// 1 unexpected failure.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSetupBlock, SetupBlockError, summarizeSetup } from '../src/cloudSetupBlock.js'
import { assertComputerCanConnect } from '../src/connectGuard.js'

const checkOnly = process.argv.includes('--check')
// With --check: also ask whether the computer's existing install may be connected to this pharmacy.
const installedRootAt = process.argv.indexOf('--installed-root')
const installedRoot = installedRootAt >= 0 ? process.argv[installedRootAt + 1] || '' : ''
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let scratchDir = ''
if (checkOnly) {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-check-'))
  process.env.HEALTHFLOW_ENV_PATH = path.join(scratchDir, '.env')
  process.on('exit', () => {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // A leftover temp folder is harmless; it only ever holds the validated copy.
    }
  })
}

const envPath = process.env.HEALTHFLOW_ENV_PATH
  ? path.resolve(process.env.HEALTHFLOW_ENV_PATH)
  : path.join(serverDir, '.env')

const refuse = (message) => {
  console.error(`NOT SAVED: ${message}`)
  console.error('Nothing was changed.')
  process.exit(2)
}

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

let input
try {
  input = parseSetupBlock(await readStdin())
} catch (error) {
  if (error instanceof SetupBlockError) refuse(error.message)
  throw error
}

if (checkOnly && installedRoot) {
  try {
    assertComputerCanConnect({
      databasePaths: [path.join(installedRoot, 'data', 'healthflow-branch.sqlite')],
      envPath: path.join(installedRoot, 'local-branch-server', '.env'),
      organizationId: input.organizationId,
    })
  } catch (error) {
    if (error?.status === 400) refuse(error.message)
    throw error
  }
}

// One rolling copy of the .env as it was, in case the technician needs to go back.
if (!checkOnly && fs.existsSync(envPath)) {
  fs.copyFileSync(envPath, `${envPath}.before-cloud-connect`)
  fs.chmodSync(`${envPath}.before-cloud-connect`, 0o600)
}

try {
  // Keep dotenv's "injected env" notices off the technician's screen.
  process.env.DOTENV_CONFIG_QUIET ??= 'true'
  // Loaded only now, so an unusable block never reaches the server's configuration code, and so the
  // --check scratch path above is in place before that code reads it.
  const { saveCloudSyncSettings } = await import('../src/tlsSettings.js')
  saveCloudSyncSettings(input)
} catch (error) {
  if (error?.status === 400) refuse(error.message)
  throw error
}

const summary = summarizeSetup(input)
if (checkOnly) {
  console.log('The setup code is complete and valid.')
  console.log(`  Organization: ${summary.organizationId}`)
  console.log(`  Branch:       ${summary.branchId}`)
  console.log(`  Cloud:        ${summary.cloudHost}`)
} else {
  console.log('Saved the cloud connection for this computer.')
  console.log(`  Organization: ${summary.organizationId}`)
  console.log(`  Branch:       ${summary.branchId}`)
  console.log(`  Cloud:        ${summary.cloudHost}`)
  console.log('  Sync token and key: received and stored (not shown)')
  console.log(`  Settings file: ${envPath}`)
}
